export const dynamic = 'force-dynamic';

import { NextRequest } from 'next/server';
import { PoolClient } from 'pg';
import { db } from '@/lib/db';
import { getSessionUser, signToken, COOKIE_NAME, COOKIE_OPTIONS } from '@/lib/auth';
import { success, error, unauthorized, serverError } from '@/lib/apiResponse';
import crypto from 'crypto';

// POST /api/payments/verify — verify Razorpay payment and confirm registrations
export async function POST(req: NextRequest) {
  let client: PoolClient | null = null;

  try {
    const session = await getSessionUser(req);
    const body = await req.json();
    const {
      payment_db_id,
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      type,
    } = body;

    let targetUserId = session?.userId;

    if (!targetUserId && (payment_db_id || razorpay_order_id)) {
      const pRes = await db.query(
        `SELECT user_id FROM payments WHERE id = $1 OR razorpay_order_id = $2`,
        [payment_db_id ?? null, razorpay_order_id ?? null]
      );
      if (pRes.rows.length > 0) {
        targetUserId = pRes.rows[0].user_id;
      }
    }

    if (!targetUserId) return unauthorized();

    const keyId = (process.env.RAZORPAY_KEY_ID || process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID || '').trim();
    const keySecret = (process.env.RAZORPAY_KEY_SECRET || '').trim();
    const isRealRazorpay =
      !!keyId &&
      !!keySecret &&
      !keyId.includes('XXXX') &&
      !keySecret.includes('XXXX') &&
      process.env.MOCK_RAZORPAY !== 'true';

    const isMockRazorpay = !isRealRazorpay;

    // =========================================================================
    // Razorpay Signature Verification
    // Performed before any DB state change.
    // Skipped only when MOCK_RAZORPAY=true is explicitly set without real keys.
    // =========================================================================
    if (isRealRazorpay) {
      if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
        return error('Missing Razorpay payment credentials', 400);
      }
      const generatedBody = `${razorpay_order_id}|${razorpay_payment_id}`;
      const expectedSignature = crypto
        .createHmac('sha256', keySecret)
        .update(generatedBody)
        .digest('hex');

      const expectedBuffer = Buffer.from(expectedSignature, 'utf8');
      const signatureBuffer = Buffer.from(razorpay_signature, 'utf8');

      if (
        expectedBuffer.length !== signatureBuffer.length ||
        !crypto.timingSafeEqual(expectedBuffer, signatureBuffer)
      ) {
        return error('Payment verification failed — invalid signature', 400);
      }
    }

    // Resolved payment and signature values used throughout the function.
    const payId: string = isMockRazorpay
      ? (razorpay_payment_id ?? `pay_mock_${Date.now()}`)
      : razorpay_payment_id;
    const sig: string = isMockRazorpay
      ? (razorpay_signature ?? 'mock_signature')
      : razorpay_signature;

    // =========================================================================
    // 1. PLATFORM FEE VERIFICATION (unchanged — not a transactional payment flow)
    // =========================================================================
    if (type === 'platform_fee') {
      await db.query(
        `UPDATE payments
         SET razorpay_payment_id = $1, razorpay_signature = $2, status = 'paid', updated_at = NOW()
         WHERE (id = $3 OR razorpay_order_id = $4) AND user_id = $5`,
        [payId, sig, payment_db_id ?? null, razorpay_order_id ?? null, targetUserId],
      );
      const userUpdateRes = await db.query(
        `UPDATE users
         SET platform_fee_paid = TRUE, 
             verification_status = 'verified', 
             pass_type = 'DELEGATE_PASS_1000', 
             platform_payment_id = $1, 
             platform_fee_paid_at = NOW()
         WHERE id = $2
         RETURNING id, full_name, email, role, qr_token, verification_status, platform_fee_paid, pass_type`,
        [payId, targetUserId],
      );
      const updatedUser = userUpdateRes.rows[0];

      const response = success({
        message: 'Payment of ₹1000 received! Your Official Festival Pass and QR Code have been activated.',
        user: updatedUser,
        qr_token: updatedUser?.qr_token,
      });

      if (updatedUser) {
        const token = await signToken({
          userId: updatedUser.id,
          email: updatedUser.email,
          role: updatedUser.role as 'student' | 'club_admin' | 'super_admin',
        });
        response.cookies.set(COOKIE_NAME, token, COOKIE_OPTIONS);
      }

      return response;
    }

    // =========================================================================
    // 2. MULTI-EVENT REGISTRATION VERIFICATION
    //
    // Transaction boundary:
    //   BEGIN
    //   → lock payment row (FOR UPDATE)           — prevent concurrent verifications
    //   → idempotency check (return if already 'paid')
    //   → fetch registrations linked to this payment only
    //   → lock event rows in deterministic order (FOR UPDATE)
    //   → for each PENDING registration:
    //       re-validate capacity under lock
    //       → CONFIRMED  (enrolled + 1) | CANCELLED (refunded)
    //   → skip CONFIRMED registrations (crash-recovery path, no double-increment)
    //   → update payment status
    //   COMMIT
    //
    // Refund API call (if required) happens AFTER COMMIT — no locks held.
    // =========================================================================
    client = await db.getClient();

    let confirmedCount = 0;
    let overbookedCount = 0;
    let paymentRecordId: string = '';
    let rzpOrderIdForReg: string | null = null;
    let needsRefund = false;

    try {
      await client.query('BEGIN');

      // ── Lock the payment row to prevent concurrent verification attempts ───
      const paymentRes = await client.query(
        `SELECT id, status, amount, razorpay_order_id
         FROM payments
         WHERE (id = $1 OR razorpay_order_id = $2) AND user_id = $3
         FOR UPDATE`,
        [payment_db_id ?? null, razorpay_order_id ?? null, targetUserId],
      );

      if (paymentRes.rows.length === 0) {
        await client.query('ROLLBACK');
        client.release();
        client = null;
        return error('Payment order record not found', 404);
      }

      const paymentRecord = paymentRes.rows[0];
      paymentRecordId = paymentRecord.id;
      rzpOrderIdForReg = paymentRecord.razorpay_order_id;

      // ── Order ID consistency check ──────────────────────────────────────────
      if (
        paymentRecord.razorpay_order_id &&
        razorpay_order_id &&
        paymentRecord.razorpay_order_id !== razorpay_order_id
      ) {
        await client.query('ROLLBACK');
        client.release();
        client = null;
        return error('Payment verification failed — order ID mismatch', 400);
      }

      // ── Idempotency: if already paid, return success without side-effects ──
      if (paymentRecord.status === 'paid') {
        await client.query('ROLLBACK');
        client.release();
        client = null;
        return success({ message: 'Payment already verified!', already_verified: true });
      }

      // ── Fetch ONLY the registrations belonging to this specific payment ────
      // The authoritative relationship is registrations.payment_id = payments.id.
      // No broad fallback based on user_id + payment_status.
      const regsRes = await client.query(
        `SELECT r.id, r.event_id, r.status, r.payment_status
         FROM registrations r
         WHERE r.payment_id = $1
         ORDER BY r.event_id`,
        [paymentRecord.id],
      );

      if (regsRes.rows.length === 0) {
        await client.query('ROLLBACK');
        client.release();
        client = null;
        return error('No registrations found for this payment order', 404);
      }

      const linkedRegs = regsRes.rows;

      // ── Lock all relevant event rows in deterministic (sorted UUID) order ──
      // Reading capacity and enrolled UNDER the lock ensures accurate values.
      const eventIds = [...new Set(linkedRegs.map((r: any) => r.event_id as string))].sort();
      const evtRes = await client.query(
        `SELECT id, capacity, enrolled, fee
         FROM events
         WHERE id = ANY($1)
         ORDER BY id
         FOR UPDATE`,
        [eventIds],
      );
      // Build a mutable map: event_id → { capacity, enrolled, fee }
      const evtMap: Record<string, { capacity: number | null; enrolled: number; fee: number }> = {};
      for (const row of evtRes.rows) {
        evtMap[row.id] = {
          capacity: row.capacity ?? null,
          enrolled: Number(row.enrolled) || 0,
          fee: Number(row.fee) || 0,
        };
      }

      // ── Process each registration ─────────────────────────────────────────
      for (const reg of linkedRegs) {
        if (reg.status === 'CONFIRMED') {
          // Crash-recovery: already confirmed in a prior attempt.
          // Count it but do NOT increment enrolled again.
          confirmedCount++;
          continue;
        }

        if (reg.status === 'CANCELLED') {
          // Previously cancelled (e.g. expired hold or prior refund path).
          overbookedCount++;
          continue;
        }

        // Only PENDING registrations are processed below.
        const evt = evtMap[reg.event_id];
        if (!evt) {
          // Event row not found (should not happen given FK constraints).
          overbookedCount++;
          continue;
        }

        if (!evt.capacity || evt.enrolled < evt.capacity) {
          // Capacity available — confirm this registration.
          await client.query(
            `UPDATE registrations
             SET status          = 'CONFIRMED',
                 payment_status  = 'paid',
                 payment_id      = $1,
                 payment_order_id = $2,
                 amount_paid     = $3,
                 confirmed_at    = NOW()
             WHERE id = $4`,
            [payId, rzpOrderIdForReg ?? razorpay_order_id ?? null, evt.fee, reg.id],
          );
          await client.query(
            `UPDATE events SET enrolled = enrolled + 1 WHERE id = $1`,
            [reg.event_id],
          );
          // Reflect the increment in the local map so subsequent iterations
          // within the same transaction see the updated count.
          evt.enrolled += 1;
          confirmedCount++;
        } else {
          // Capacity exhausted after the 15-minute hold expired.
          await client.query(
            `UPDATE registrations
             SET status          = 'CANCELLED',
                 payment_status  = 'refunded',
                 payment_id      = $1,
                 payment_order_id = $2,
                 updated_at      = NOW()
             WHERE id = $3`,
            [payId, rzpOrderIdForReg ?? razorpay_order_id ?? null, reg.id],
          );
          overbookedCount++;
        }
      }

      // ── Update payment status ─────────────────────────────────────────────
      if (overbookedCount > 0 && confirmedCount === 0) {
        // All events were overbooked — mark payment for refund.
        await client.query(
          `UPDATE payments
           SET status = 'refunded', razorpay_payment_id = $1, razorpay_signature = $2, updated_at = NOW()
           WHERE id = $3`,
          [payId, sig, paymentRecord.id],
        );
        needsRefund = true;
      } else {
        // At least one registration confirmed — payment is paid.
        await client.query(
          `UPDATE payments
           SET status = 'paid', razorpay_payment_id = $1, razorpay_signature = $2, updated_at = NOW()
           WHERE id = $3`,
          [payId, sig, paymentRecord.id],
        );
        if (paymentRecord.user_id) {
          await client.query(
            `UPDATE users SET platform_fee_paid = true WHERE id = $1`,
            [paymentRecord.user_id],
          );
        }
      }

      await client.query('COMMIT');
      client.release();
      client = null;
    } catch (txErr) {
      if (client) {
        try {
          await client.query('ROLLBACK');
        } catch {
          /* ignore */
        }
        client.release();
        client = null;
      }
      throw txErr; // re-throw to outer catch
    }

    // =========================================================================
    // Post-COMMIT: Razorpay refund API call (if all events were overbooked)
    // No DB locks are held here.
    // =========================================================================
    if (needsRefund && isRealRazorpay && razorpay_payment_id) {
      try {
        const authHeader = Buffer.from(
          `${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`,
        ).toString('base64');
        const refundRes = await fetch(
          `https://api.razorpay.com/v1/payments/${razorpay_payment_id}/refund`,
          {
            method: 'POST',
            headers: {
              Authorization: `Basic ${authHeader}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ speed: 'optimum' }),
          },
        );
        if (!refundRes.ok) {
          // Non-fatal: DB already reflects 'refunded'. Alert ops team separately.
          console.error('[Razorpay] Auto-refund trigger failed:', refundRes.status);
        }
      } catch (refundErr) {
        console.error('[Razorpay] Auto-refund network error:', (refundErr as Error).message);
      }
    }

    if (needsRefund) {
      return success({
        message:
          'Capacity for selected events was filled after hold expiry. ' +
          'Your payment has been marked for automatic refund.',
        refunded: true,
        confirmed_count: 0,
      });
    }

    return success({
      message:
        overbookedCount > 0
          ? `${confirmedCount} registration(s) confirmed. ${overbookedCount} event(s) were filled after hold expiry and queued for refund.`
          : `${confirmedCount} event registration(s) confirmed!`,
      confirmed_count: confirmedCount,
      refunded_count: overbookedCount,
    });
  } catch (err) {
    if (client) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* ignore */
      }
      client.release();
    }
    console.error('[verify] Unexpected error:', (err as Error).message);
    return serverError();
  }
}
