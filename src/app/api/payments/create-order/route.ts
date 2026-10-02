export const dynamic = 'force-dynamic';

import { NextRequest } from 'next/server';
import { PoolClient } from 'pg';
import { db } from '@/lib/db';
import { getSessionUser } from '@/lib/auth';
import { success, error, unauthorized, serverError } from '@/lib/apiResponse';
import { calculatePayableFees, isStudentProfileComplete } from '@/lib/institutionPolicy';

// ---------------------------------------------------------------------------
// Internal error class — user-facing validation errors raised inside the
// transaction so the catch block can distinguish them from unexpected errors.
// ---------------------------------------------------------------------------
class UserError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number = 400,
  ) {
    super(message);
    this.name = 'UserError';
  }
}

// ---------------------------------------------------------------------------
// Razorpay helpers
// ---------------------------------------------------------------------------

/**
 * True when real Razorpay credentials are configured and MOCK_RAZORPAY is not explicitly set.
 * Evaluated at call time (not module level) so env changes in tests are respected.
 */
function isRealRazorpay(): boolean {
  const keyId = (process.env.RAZORPAY_KEY_ID || process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID || '').trim();
  const keySecret = (process.env.RAZORPAY_KEY_SECRET || '').trim();
  return (
    !!keyId &&
    !!keySecret &&
    !keyId.includes('XXXX') &&
    !keySecret.includes('XXXX') &&
    process.env.MOCK_RAZORPAY !== 'true'
  );
}

/** True when MOCK_RAZORPAY=true or when valid keys are absent in development. */
function isMockRazorpay(): boolean {
  return process.env.MOCK_RAZORPAY === 'true' || !isRealRazorpay();
}

// ---------------------------------------------------------------------------
// POST /api/payments/create-order
// ---------------------------------------------------------------------------
export async function POST(req: NextRequest) {
  let client: PoolClient | null = null;

  try {
    // ── Authentication ────────────────────────────────────────────────────
    const session = await getSessionUser(req);
    if (!session) return unauthorized();

    const body = await req.json();
    const { type, event_id, event_ids: bodyEventIds, team_names = {} } = body;

    if (!type || !['platform_fee', 'event_fee'].includes(type)) {
      return error('Invalid payment type');
    }

    // =========================================================================
    // 1. PLATFORM FEE PAYMENT FLOW (unchanged — not part of multi-event cart)
    // =========================================================================
    if (type === 'platform_fee') {
      const configResult = await db.query(
        `SELECT value FROM platform_config WHERE key = 'platform_fee'`,
      );
      const amount = parseInt(configResult.rows[0]?.value || '1000') * 100; // paise (₹1000)

      const userResult = await db.query(
        `SELECT is_amrita_student, platform_fee_paid FROM users WHERE id = $1`,
        [session.userId],
      );
      const userRow = userResult.rows[0];

      if (userRow?.is_amrita_student) {
        await db.query(`UPDATE users SET platform_fee_paid = true, verification_status = 'verified' WHERE id = $1`, [session.userId]);
        return success({
          order_id: `free_amrita_${Date.now()}`,
          amount: 0,
          currency: 'INR',
          description: 'Complimentary Amrita Student Pass',
          is_free: true,
        });
      }
      if (userRow?.platform_fee_paid) {
        return error('Platform fee already paid', 409);
      }

      const rzpKeyId = (process.env.RAZORPAY_KEY_ID || process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID || '').trim();
      const rzpSecret = (process.env.RAZORPAY_KEY_SECRET || '').trim();
      let rzpOrderId: string;

      if (isRealRazorpay()) {
        try {
          const authHeader = Buffer.from(`${rzpKeyId}:${rzpSecret}`).toString('base64');
          const rzpRes = await fetch('https://api.razorpay.com/v1/orders', {
            method: 'POST',
            headers: {
              Authorization: `Basic ${authHeader}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              amount,
              currency: 'INR',
              receipt: `pf_${Date.now().toString().slice(-8)}`,
              notes: {
                userId: session.userId,
                userEmail: session.email,
                type: 'platform_fee',
                passName: 'Parinaam 2026 Official Festival Pass',
              },
            }),
          });

          if (rzpRes.ok) {
            const rzpData = await rzpRes.json();
            rzpOrderId = rzpData.id;
          } else {
            const errText = await rzpRes.text();
            let parsedErr = 'Could not create Razorpay order.';
            try {
              const parsed = JSON.parse(errText);
              if (parsed.error?.description) parsedErr = parsed.error.description;
            } catch {}
            console.error('[Razorpay Platform Fee Error]', rzpRes.status, errText);
            return error(parsedErr, 502);
          }
        } catch (err: any) {
          console.error('[Razorpay Platform Fee Network Error]', err);
          return error('Payment gateway is unreachable. Please try again.', 502);
        }
      } else {
        rzpOrderId = `order_mock_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
      }

      const paymentResult = await db.query(
        `INSERT INTO payments (user_id, type, amount, razorpay_order_id, status)
         VALUES ($1, 'platform_fee', $2, $3, 'created') RETURNING id`,
        [session.userId, amount, rzpOrderId],
      );
      return success({
        order_id: rzpOrderId,
        amount,
        currency: 'INR',
        description: 'Parinaam 2026 Official Festival Pass (₹1000 Fixed Entry)',
        payment_db_id: paymentResult.rows[0].id,
        key_id: rzpKeyId,
        is_mock: isMockRazorpay(),
      });
    }

    // =========================================================================
    // 2. MULTI-EVENT REGISTRATION PAYMENT FLOW
    // =========================================================================

    // Normalise and deduplicate event IDs from client (untrusted).
    // Sort deterministically to prevent deadlocks when multiple transactions
    // attempt to lock the same event rows concurrently.
    const rawIds: string[] =
      Array.isArray(bodyEventIds) && bodyEventIds.length > 0
        ? bodyEventIds
        : event_id
          ? [event_id]
          : [];

    if (rawIds.length === 0) {
      return error('At least one Event ID is required');
    }

    const eventIds = [...new Set(rawIds)].sort() as string[];

    // ── Pre-transaction user check (read-only, no locks needed) ──────────────
    const userRes = await db.query(
      `SELECT id, email, role, phone, college_name, department, year_of_study, is_amrita_student, id_card_url, verification_status, platform_fee_paid
       FROM users WHERE id = $1`,
      [session.userId],
    );
    const user = userRes.rows[0];
    if (!user) return unauthorized();

    if (session.role !== 'student') {
      return error('Event registration checkout is restricted to student accounts.', 403);
    }

    if (!isStudentProfileComplete(user)) {
      return error(
        'Platform registration/profile completion is required before registering for events. Please complete your profile in your dashboard first.',
        400,
      );
    }


    if (user.verification_status !== 'verified') {
      return error(
        'Your account verification is pending Super Admin approval. You will be able to register once verified.',
        403,
      );
    }


    // =========================================================================
    // PHASE A — PostgreSQL Transaction
    //
    // Boundary:  BEGIN → lock events → validate → insert payment →
    //            insert PENDING registrations → COMMIT
    //
    // The Razorpay API call occurs AFTER COMMIT so no PostgreSQL locks are
    // held during the external network request.
    // =========================================================================
    client = await db.getClient();

    interface TxResult {
      paymentDbId: string;
      totalAmountPaise: number;
      targetEventsCount: number;
      isFree: boolean;
    }
    let txResult: TxResult | null = null;

    try {
      await client.query('BEGIN');

      // Lock event rows in deterministic (sorted UUID) order to prevent deadlocks.
      const eventsRes = await client.query(
        `SELECT id, name, fee, capacity, enrolled, registration_open, status
         FROM events
         WHERE id = ANY($1)
         ORDER BY id
         FOR UPDATE`,
        [eventIds],
      );

      if (eventsRes.rows.length !== eventIds.length) {
        throw new UserError('One or more selected events were not found.', 404);
      }

      const targetEvents = eventsRes.rows;

      // Validate event status and registration window for each event.
      for (const evt of targetEvents) {
        if (!evt.registration_open || evt.status !== 'published') {
          throw new UserError(
            `Registration for event "${evt.name}" is currently closed.`,
            400,
          );
        }
      }

      // Reject if the user already has a CONFIRMED registration for any event in the cart.
      const existingRegsRes = await client.query(
        `SELECT event_id FROM registrations
         WHERE user_id = $1 AND event_id = ANY($2) AND status = 'CONFIRMED'`,
        [session.userId, eventIds],
      );
      if (existingRegsRes.rows.length > 0) {
        const dup = targetEvents.find(e => e.id === existingRegsRes.rows[0].event_id);
        throw new UserError(
          `You are already registered for "${dup?.name ?? 'an event in your cart'}".`,
          409,
        );
      }

      // Capacity check — count CONFIRMED registrations plus active 15-minute PENDING holds.
      for (const evt of targetEvents) {
        if (evt.capacity) {
          const holdRes = await client.query(
            `SELECT COUNT(*)::int AS count
             FROM registrations
             WHERE event_id = $1
               AND (
                 status = 'CONFIRMED'
                 OR (status = 'PENDING' AND registered_at > NOW() - INTERVAL '15 minutes')
               )`,
            [evt.id],
          );
          const activeCount = Number(holdRes.rows[0]?.count ?? 0);
          if (activeCount >= evt.capacity) {
            throw new UserError(
              `Event "${evt.name}" is at full capacity or pending checkout by another student.`,
              409,
            );
          }
        }
      }

      // Calculate total fee from DB values and institutional policy — client-supplied amounts are never trusted.
      const feeCalc = calculatePayableFees(user, targetEvents);
      const totalAmountPaise = feeCalc.totalFee * 100;

      // Insert one payment record in the intermediate 'created' state.
      // razorpay_order_id is NULL here; it is set in Phase B after COMMIT.
      const paymentRes = await client.query(
        `INSERT INTO payments (user_id, type, amount, status)
         VALUES ($1, 'event_fee', $2, 'created')
         RETURNING id`,
        [session.userId, totalAmountPaise],
      );
      const paymentDbId: string = paymentRes.rows[0].id;

      // Insert one PENDING registration per event, all linked to this payment.
      // ON CONFLICT handles the case where a prior hold exists (PENDING/CANCELLED).
      // The WHERE guard prevents overwriting a CONFIRMED row (should not be reached
      // given the check above, but is a defensive layer).
      for (const evt of targetEvents) {
        const teamName = (team_names as Record<string, string>)[evt.id] ?? null;
        await client.query(
          `INSERT INTO registrations
             (user_id, event_id, team_name, amount_paid, payment_id, status, payment_status, registered_at)
           VALUES ($1, $2, $3, 0, $4, 'PENDING', 'pending', NOW())
           ON CONFLICT (user_id, event_id) DO UPDATE
             SET payment_id    = EXCLUDED.payment_id,
                 status        = 'PENDING',
                 payment_status = 'pending',
                 registered_at = NOW()
             WHERE registrations.status <> 'CONFIRMED'`,
          [session.userId, evt.id, teamName, paymentDbId],
        );
      }

      // ── Free-events shortcut — confirm everything inside the same transaction ──
      if (totalAmountPaise === 0) {
        const freeOrderId = `free_evt_${Date.now()}`;
        await client.query(
          `UPDATE payments
           SET status = 'paid', razorpay_order_id = $1, updated_at = NOW()
           WHERE id = $2`,
          [freeOrderId, paymentDbId],
        );
        await client.query(
          `UPDATE registrations
           SET status = 'CONFIRMED', payment_status = 'paid', confirmed_at = NOW()
           WHERE payment_id = $1`,
          [paymentDbId],
        );
        for (const evt of targetEvents) {
          await client.query(
            `UPDATE events SET enrolled = enrolled + 1 WHERE id = $1`,
            [evt.id],
          );
        }
        await client.query('COMMIT');
        client.release();
        client = null;

        return success({
          order_id: freeOrderId,
          amount: 0,
          currency: 'INR',
          payment_db_id: paymentDbId,
          is_free: true,
        });
      }

      // ── Paid path — COMMIT and release all locks before calling Razorpay ────
      await client.query('COMMIT');
      client.release();
      client = null;
      // All PostgreSQL row locks are now released.

      txResult = {
        paymentDbId,
        totalAmountPaise,
        targetEventsCount: targetEvents.length,
        isFree: false,
      };
    } catch (txErr) {
      // Roll back and release before returning / re-throwing.
      if (client) {
        try {
          await client.query('ROLLBACK');
        } catch {
          /* ignore rollback errors */
        }
        client.release();
        client = null;
      }
      if (txErr instanceof UserError) {
        return error(txErr.message, txErr.statusCode);
      }
      throw txErr; // unexpected error — re-throw to outer catch
    }

    // txResult is guaranteed to be set here (free path returns above, errors throw).
    if (!txResult) return serverError();

    const { paymentDbId, totalAmountPaise, targetEventsCount } = txResult;

    // =========================================================================
    // PHASE B — Razorpay Order Creation (OUTSIDE the DB transaction)
    //
    // PostgreSQL locks have already been released by COMMIT above.
    // Failure here marks the payment as 'failed' and cancels the PENDING
    // registrations so the student can retry.
    // =========================================================================
    let rzpOrderId: string;

    if (isRealRazorpay()) {
      // ── Real Razorpay API call ─────────────────────────────────────────────
      try {
        const rzpKeyId = (process.env.RAZORPAY_KEY_ID || process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID || '').trim();
        const rzpSecret = (process.env.RAZORPAY_KEY_SECRET || '').trim();
        const authHeader = Buffer.from(
          `${rzpKeyId}:${rzpSecret}`,
        ).toString('base64');

        const safeReceipt = paymentDbId && paymentDbId.length > 40 ? paymentDbId.slice(0, 40) : (paymentDbId || `rcpt_${Date.now()}`);

        const rzpRes = await fetch('https://api.razorpay.com/v1/orders', {
          method: 'POST',
          headers: {
            Authorization: `Basic ${authHeader}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            amount: totalAmountPaise,
            currency: 'INR',
            receipt: safeReceipt,
          }),
        });

        if (!rzpRes.ok) {
          const body = await rzpRes.text();
          let gatewayErr = 'Payment gateway order creation failed.';
          try {
            const parsed = JSON.parse(body);
            if (parsed.error?.description) gatewayErr = parsed.error.description;
          } catch {}
          console.error('[Razorpay] Order creation failed:', rzpRes.status, body.slice(0, 300));
          await db.query(
            `UPDATE payments SET status = 'failed', updated_at = NOW() WHERE id = $1`,
            [paymentDbId],
          );
          await db.query(
            `UPDATE registrations SET status = 'CANCELLED' WHERE payment_id = $1`,
            [paymentDbId],
          );
          return error(`${gatewayErr} Please check credentials or try again.`, 502);
        }

        const rzpOrder = await rzpRes.json();
        rzpOrderId = rzpOrder.id as string;
      } catch (rzpErr) {
        console.error(
          '[Razorpay] Network error during order creation:',
          (rzpErr as Error).message,
        );
        await db.query(
          `UPDATE payments SET status = 'failed', updated_at = NOW() WHERE id = $1`,
          [paymentDbId],
        );
        await db.query(
          `UPDATE registrations SET status = 'CANCELLED' WHERE payment_id = $1`,
          [paymentDbId],
        );
        return error('Payment gateway is unreachable. Please try again.', 502);
      }
    } else {
      // ── Development / Mock mode fallback ─────────────────────────────────────
      rzpOrderId = `order_mock_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
    }

    // Persist the Razorpay order ID on the payment record.
    await db.query(
      `UPDATE payments SET razorpay_order_id = $1, updated_at = NOW() WHERE id = $2`,
      [rzpOrderId, paymentDbId],
    );

    return success({
      order_id: rzpOrderId,
      amount: totalAmountPaise,
      currency: 'INR',
      description: `Registration for ${targetEventsCount} Event(s)`,
      payment_db_id: paymentDbId,
      key_id: (process.env.RAZORPAY_KEY_ID || process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID || '').trim(),
      is_mock: isMockRazorpay(),
    });
  } catch (err) {
    // Ensure the client is always released on unexpected errors.
    if (client) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* ignore */
      }
      client.release();
    }
    console.error('[create-order] Unexpected error:', (err as Error).message);
    return serverError();
  }
}
