import { NextRequest } from 'next/server';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import { db } from '@/lib/db';
import { signToken, signRegistrationToken, COOKIE_NAME, COOKIE_OPTIONS } from '@/lib/auth';
import { success, error, serverError } from '@/lib/apiResponse';
import { isInstitutionalEmail, STANDARD_PLATFORM_FEE_INR } from '@/lib/institutionPolicy';
import { isValidEmail, isValidStudentName } from '@/lib/utils';

const AMRITA_DOMAIN = 'av.students.amrita.edu';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const {
      student_type,
      email,
      password,
      full_name,
      phone,
      college_name,
      roll_number,
      department,
      year_of_study,
      city,
      id_card_url,
    } = body;

    // Validate required fields
    if (!email || !password || !full_name) {
      return error('Email, password and full name are required');
    }

    const emailLower = email.toLowerCase().trim();
    if (!isValidEmail(emailLower)) {
      return error('Please enter a valid email address');
    }

    const nameCheck = isValidStudentName(full_name);
    if (!nameCheck.valid) {
      return error(nameCheck.error || 'Student name is invalid');
    }

    if (password.length < 8) {
      return error('Password must be at least 8 characters');
    }

    // Check if Amrita student based on selection or recognized institutional email domain
    const isAmritaDomain = isInstitutionalEmail(emailLower);
    
    if (student_type === 'amrita' && !isAmritaDomain) {
      return error(`Amrita students must use their official college email (e.g., yourname@av.students.amrita.edu)`);
    }

    if (student_type === 'other') {
      if (!college_name?.trim()) return error('College / Institution name is required');
      if (!department?.trim()) return error('Branch / Department name is required');
      if (!city?.trim()) return error('City / Location is required');
    }

    if (student_type === 'amrita') {
      if (!roll_number?.trim()) return error('Amrita Roll Number is required');
      if (!department?.trim()) return error('Branch is required');
    }

    if (!year_of_study) {
      return error('Year of study is required');
    }

    const isAmritaStudent = student_type === 'amrita' || (student_type !== 'other' && isAmritaDomain);

    // Check if email already exists as a verified user
    const existing = await db.query(
      'SELECT id, email, platform_fee_paid, verification_status FROM users WHERE email = $1',
      [emailLower]
    );
    if (existing.rows.length > 0) {
      const existingUser = existing.rows[0];
      if (existingUser.verification_status === 'verified' || existingUser.platform_fee_paid) {
        return error('An account with this email already exists. Please log in.', 409);
      }
    }

    const cleanPhone = (phone || '').replace(/\D/g, '').slice(0, 10);
    if (!cleanPhone || cleanPhone.length !== 10) {
      return error('Phone number must be exactly 10 digits');
    }
    if (!/^[6-9]\d{9}$/.test(cleanPhone)) {
      return error('Phone number must start with 6, 7, 8, or 9 (excluding +91)');
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, 12);

    // Generate unique QR token
    const qrToken = uuidv4().replace(/-/g, '') + uuidv4().replace(/-/g, '').slice(0, 8);
    const emailVerifyToken = uuidv4();

    // =========================================================================
    // 1. AMRITA STUDENT FLOW: Instantly verified, free pass, created in DB
    // =========================================================================
    if (isAmritaStudent) {
      const result = await db.query(
        `INSERT INTO users (
          email, password_hash, full_name, phone,
          college_name, is_amrita_student, roll_number, department,
          year_of_study, city, verification_status, qr_token,
          email_verify_token, email_verified, platform_fee_paid, id_card_url, pass_type
        ) VALUES ($1,$2,$3,$4,$5,TRUE,$6,$7,$8,$9,'verified',$10,$11,TRUE,TRUE,$12,'AMRITA_FREE')
        RETURNING id, email, full_name, role, is_amrita_student, verification_status, qr_token, platform_fee_paid, id_card_url, pass_type`,
        [
          emailLower,
          passwordHash,
          full_name,
          cleanPhone,
          'Amrita Vishwa Vidyapeetham, Amaravati',
          roll_number || null,
          department || null,
          year_of_study || null,
          city || null,
          qrToken,
          emailVerifyToken,
          id_card_url || null,
        ]
      );

      const user = result.rows[0];
      const token = await signToken({
        userId: user.id,
        email: user.email,
        role: user.role as 'student' | 'club_admin' | 'super_admin',
      });

      const response = success({
        user,
        is_amrita_student: true,
        requires_payment: false,
      }, 201);
      response.cookies.set(COOKIE_NAME, token, COOKIE_OPTIONS);
      return response;
    }

    // =========================================================================
    // 2. OUTSIDE STUDENT FLOW: No DB row created yet!
    // Temporary registration token signed for secure post-payment verification.
    // =========================================================================
    const registrationToken = await signRegistrationToken({
      email: emailLower,
      password_hash: passwordHash,
      full_name,
      phone: cleanPhone,
      college_name,
      roll_number: roll_number || null,
      department: department || null,
      year_of_study: year_of_study || null,
      city: city || null,
      id_card_url: id_card_url || null,
      qr_token: qrToken,
      emailVerifyToken,
    });

    const amountPaise = STANDARD_PLATFORM_FEE_INR * 100; // 100000 paise (₹1000)
    const rzpKeyId = process.env.RAZORPAY_KEY_ID;
    const rzpSecret = process.env.RAZORPAY_KEY_SECRET;

    let rzpOrderId: string;

    try {
      const authHeader = Buffer.from(`${rzpKeyId}:${rzpSecret}`).toString('base64');
      const rzpRes = await fetch('https://api.razorpay.com/v1/orders', {
        method: 'POST',
        headers: {
          Authorization: `Basic ${authHeader}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          amount: amountPaise,
          currency: 'INR',
          receipt: `pf_${Date.now().toString().slice(-8)}`,
          notes: {
            type: 'platform_fee',
            passName: 'Parinaam 2026 Delegate Pass (Includes 4 Flagship Events)',
          },
        }),
      });

      if (rzpRes.ok) {
        const rzpData = await rzpRes.json();
        rzpOrderId = rzpData.id;
      } else {
        const errText = await rzpRes.text();
        console.warn('[Razorpay] Order API returned error status:', rzpRes.status, errText);
        rzpOrderId = `order_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
      }
    } catch (rzpErr) {
      console.error('[Razorpay] Network error, fallback order generated:', rzpErr);
      rzpOrderId = `order_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    }

    const razorpayOrder = {
      order_id: rzpOrderId,
      amount: amountPaise,
      currency: 'INR',
      key_id: rzpKeyId,
      registration_token: registrationToken,
      description: 'PARINAAM 2026 Festival Pass (₹1000 Fixed Entry)',
      included_events: [
        'Live Concert and DJ',
        'Garba Night',
        'Auto Expo',
        'Tholu Bommalata',
      ],
    };

    return success({
      user: null,
      is_amrita_student: false,
      requires_payment: true,
      razorpay_order: razorpayOrder,
    }, 201);
  } catch (err: any) {
    console.error('Registration error:', err);
    return error(err?.message || 'Registration failed. Please try again.', 500);
  }
}
