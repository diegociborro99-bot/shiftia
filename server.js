const express = require('express');
const path = require('path');
const nodemailer = require('nodemailer');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'shiftia-secret-dev-2024';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ====== DATABASE CONFIG ======
// Filter out undefined values to avoid overriding connectionString
const poolConfig = process.env.DATABASE_URL
  ? { connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } }
  : {
      host: process.env.PGHOST,
      port: process.env.PGPORT || 5432,
      database: process.env.PGDATABASE,
      user: process.env.PGUSER,
      password: process.env.PGPASSWORD,
    };

const pool = new Pool(poolConfig);

// Test database connection
pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
});

// ====== DATABASE INITIALIZATION ======
async function initializeDatabase() {
  try {
    const client = await pool.connect();

    // Create users table
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        name VARCHAR(255) NOT NULL,
        company VARCHAR(255),
        plan VARCHAR(50) DEFAULT 'trial',
        plan_status VARCHAR(50) DEFAULT 'active',
        workers_limit INTEGER DEFAULT 25,
        next_billing_date DATE,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // Create support tickets table
    await client.query(`
      CREATE TABLE IF NOT EXISTS support_tickets (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        category VARCHAR(50) DEFAULT 'general',
        subject VARCHAR(500) NOT NULL,
        message TEXT NOT NULL,
        status VARCHAR(50) DEFAULT 'open',
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // Create bookings table
    await client.query(`
      CREATE TABLE IF NOT EXISTS bookings (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        email VARCHAR(255) NOT NULL,
        phone VARCHAR(50) NOT NULL,
        company VARCHAR(255),
        workers VARCHAR(50),
        department VARCHAR(255),
        message TEXT,
        booking_date DATE NOT NULL,
        booking_time VARCHAR(10) NOT NULL,
        status VARCHAR(50) DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // Create contact leads table
    await client.query(`
      CREATE TABLE IF NOT EXISTS contact_leads (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        email VARCHAR(255) NOT NULL,
        company VARCHAR(255),
        workers VARCHAR(50),
        department VARCHAR(255),
        message TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // Create schedule data table (stores entire SARA workspace per user)
    await client.query(`
      CREATE TABLE IF NOT EXISTS schedule_data (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        data JSONB NOT NULL DEFAULT '{}',
        updated_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(user_id)
      );
    `);

    console.log('Database initialized: all tables created');

    // Seed Sara admin user (SAV)
    const saraEmail = 'sara@shiftia.es';
    const existingSara = await client.query('SELECT id FROM users WHERE email = $1', [saraEmail]);

    if (existingSara.rows.length === 0) {
      const hashedPassword = await bcrypt.hash('vinicius1', 10);
      await client.query(`
        INSERT INTO users (email, password_hash, name, company, plan, plan_status, workers_limit)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
      `, [saraEmail, hashedPassword, 'Sara — Supervisora', 'Hospital de Jove', 'enterprise', 'active', 1000]);
      console.log('Admin user created: sara@shiftia.es (SAV)');
    }

    client.release();
  } catch (err) {
    console.error('Database initialization error:', err.message);
    process.exit(1);
  }
}

// ====== MIDDLEWARE ======
// JWT Authentication Middleware
function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }

  const token = authHeader.slice(7);

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    console.error('Token verification error:', err.message);
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// ====== HELPER FUNCTIONS ======
// Validate email format
function isValidEmail(email) {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

// ====== EMAIL CONFIG ======
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER || 'highkeycvsender@gmail.com',
    pass: process.env.GMAIL_APP_PASSWORD || ''
  }
});

// ====== AUTHENTICATION ROUTES ======
// POST /api/auth/register
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, name, company } = req.body;

    // Validate required fields
    if (!email || !password || !name) {
      return res.status(400).json({ error: 'Email, password, and name are required' });
    }

    // Validate email format
    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    // Validate password strength (at least 8 chars)
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    // Check if email already exists
    const existingUser = await pool.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
    if (existingUser.rows.length > 0) {
      return res.status(409).json({ error: 'Email already exists' });
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, 10);

    // Insert user
    const result = await pool.query(
      `INSERT INTO users (email, password_hash, name, company, plan, plan_status, workers_limit)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, email, name, company, plan, plan_status, workers_limit, created_at`,
      [email.toLowerCase(), passwordHash, name, company || null, 'trial', 'active', 25]
    );

    const user = result.rows[0];

    // Generate JWT token
    const token = jwt.sign(
      { id: user.id, email: user.email },
      JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.status(201).json({ token, user });
  } catch (err) {
    console.error('Register error:', err.message);
    res.status(500).json({ error: 'Error creating account' });
  }
});

// Username → email mapping for single-user mode
const USERNAME_MAP = {
  'sav': 'sara@shiftia.es',
};

// POST /api/auth/login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password, username } = req.body;

    // Resolve login identifier: username (SAV) or email
    let loginEmail = email;
    if (username && !email) {
      loginEmail = USERNAME_MAP[username.toLowerCase()] || username.toLowerCase();
    }

    // Validate required fields
    if (!loginEmail || !password) {
      return res.status(400).json({ error: 'Usuario y contraseña son obligatorios' });
    }

    // Find user by email
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [loginEmail.toLowerCase()]);
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = result.rows[0];

    // Compare password
    const passwordMatch = await bcrypt.compare(password, user.password_hash);
    if (!passwordMatch) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Generate JWT token
    const token = jwt.sign(
      { id: user.id, email: user.email },
      JWT_SECRET,
      { expiresIn: '30d' }
    );

    // Return user without password_hash
    const { password_hash, ...userWithoutPassword } = user;

    res.json({ token, user: userWithoutPassword });
  } catch (err) {
    console.error('Login error:', err.message);
    res.status(500).json({ error: 'Login failed' });
  }
});

// GET /api/auth/me (protected)
app.get('/api/auth/me', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, email, name, company, plan, plan_status, workers_limit, next_billing_date, created_at, updated_at FROM users WHERE id = $1',
      [req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({ user: result.rows[0] });
  } catch (err) {
    console.error('Get user error:', err.message);
    res.status(500).json({ error: 'Error fetching user' });
  }
});

// PUT /api/auth/update (protected)
app.put('/api/auth/update', authMiddleware, async (req, res) => {
  try {
    const { name, email, company, password } = req.body;
    const userId = req.user.id;

    // Validate at least one field
    if (!name && !email && !company && !password) {
      return res.status(400).json({ error: 'At least one field is required' });
    }

    // Start building the update query
    const updates = [];
    const values = [];
    let paramCount = 1;

    if (name) {
      updates.push(`name = $${paramCount}`);
      values.push(name);
      paramCount++;
    }

    if (email) {
      if (!isValidEmail(email)) {
        return res.status(400).json({ error: 'Invalid email format' });
      }
      // Check if email is already taken by another user
      const existingUser = await pool.query('SELECT id FROM users WHERE email = $1 AND id != $2', [email.toLowerCase(), userId]);
      if (existingUser.rows.length > 0) {
        return res.status(409).json({ error: 'Email already in use' });
      }
      updates.push(`email = $${paramCount}`);
      values.push(email.toLowerCase());
      paramCount++;
    }

    if (company) {
      updates.push(`company = $${paramCount}`);
      values.push(company);
      paramCount++;
    }

    if (password) {
      if (password.length < 8) {
        return res.status(400).json({ error: 'Password must be at least 8 characters' });
      }
      const passwordHash = await bcrypt.hash(password, 10);
      updates.push(`password_hash = $${paramCount}`);
      values.push(passwordHash);
      paramCount++;
    }

    updates.push(`updated_at = NOW()`);

    values.push(userId);

    const query = `
      UPDATE users
      SET ${updates.join(', ')}
      WHERE id = $${paramCount}
      RETURNING id, email, name, company, plan, plan_status, workers_limit, next_billing_date, created_at, updated_at
    `;

    const result = await pool.query(query, values);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({ user: result.rows[0] });
  } catch (err) {
    console.error('Update user error:', err.message);
    res.status(500).json({ error: 'Error updating user' });
  }
});

// ====== SCHEDULE DATA ROUTES ======
// GET /api/data (protected) — Load user's SARA workspace data
app.get('/api/data', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT data FROM schedule_data WHERE user_id = $1',
      [req.user.id]
    );

    if (result.rows.length === 0) {
      return res.json({}); // No data yet — fresh workspace
    }

    res.json(result.rows[0].data);
  } catch (err) {
    console.error('Load data error:', err.message);
    res.status(500).json({ error: 'Error loading data' });
  }
});

// POST /api/data (protected) — Save user's SARA workspace data
app.post('/api/data', authMiddleware, async (req, res) => {
  try {
    const data = req.body;

    if (!data || typeof data !== 'object') {
      return res.status(400).json({ error: 'Invalid data format' });
    }

    // Upsert: insert or update
    await pool.query(`
      INSERT INTO schedule_data (user_id, data, updated_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (user_id) DO UPDATE
      SET data = $2, updated_at = NOW()
    `, [req.user.id, JSON.stringify(data)]);

    res.json({ success: true });
  } catch (err) {
    console.error('Save data error:', err.message);
    res.status(500).json({ error: 'Error saving data' });
  }
});

// POST /api/support (protected)
app.post('/api/support', authMiddleware, async (req, res) => {
  try {
    const { category, subject, message } = req.body;

    // Validate required fields
    if (!subject || !message) {
      return res.status(400).json({ error: 'Subject and message are required' });
    }

    // Get user details
    const userResult = await pool.query(
      'SELECT email, name, company FROM users WHERE id = $1',
      [req.user.id]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = userResult.rows[0];
    const cat = category || 'general';
    const catLabels = { general: 'Consulta general', bug: 'Reporte de error', billing: 'Facturación', feature: 'Sugerencia de mejora' };

    // Save ticket to database (primary)
    try {
      await pool.query(
        'INSERT INTO support_tickets (user_id, category, subject, message) VALUES ($1, $2, $3, $4)',
        [req.user.id, cat, subject, message]
      );
    } catch (dbErr) {
      if (dbErr.message.includes('does not exist')) {
        await pool.query(`
          CREATE TABLE IF NOT EXISTS support_tickets (
            id SERIAL PRIMARY KEY, user_id INTEGER, category VARCHAR(50) DEFAULT 'general',
            subject VARCHAR(500) NOT NULL, message TEXT NOT NULL,
            status VARCHAR(50) DEFAULT 'open', created_at TIMESTAMP DEFAULT NOW()
          );
        `);
        await pool.query(
          'INSERT INTO support_tickets (user_id, category, subject, message) VALUES ($1, $2, $3, $4)',
          [req.user.id, cat, subject, message]
        );
      } else {
        console.warn('DB insert ticket failed (continuing):', dbErr.message);
      }
    }

    console.log(`Support ticket from ${user.name} <${user.email}>: [${cat}] ${subject}`);
    res.json({ ok: true });

    // Fire-and-forget email (don't block response)
    try {
      if (process.env.GMAIL_APP_PASSWORD) {
        transporter.sendMail({
          from: `"Shiftia Support" <${process.env.GMAIL_USER || 'highkeycvsender@gmail.com'}>`,
          to: process.env.SUPPORT_EMAIL || 'highkeycvsender@gmail.com',
          subject: `[Soporte - ${catLabels[cat] || cat}] ${subject}`,
          html: `
            <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 32px;">
              <div style="background: linear-gradient(135deg, #4ecdc4, #2980b9); padding: 24px 32px; border-radius: 12px 12px 0 0;">
                <h1 style="color: white; margin: 0; font-size: 1.4rem;">${catLabels[cat] || cat}: ${subject}</h1>
              </div>
              <div style="background: #f8fafc; padding: 32px; border: 1px solid #e2e8f0; border-top: none; border-radius: 0 0 12px 12px;">
                <table style="width: 100%; border-collapse: collapse; margin-bottom: 24px;">
                  <tr><td style="padding: 10px 0; color: #64748b; font-weight: 600; width: 110px;">Nombre</td><td style="padding: 10px 0; color: #1e293b;">${user.name}</td></tr>
                  <tr><td style="padding: 10px 0; color: #64748b; font-weight: 600;">Email</td><td style="padding: 10px 0;"><a href="mailto:${user.email}" style="color: #2980b9;">${user.email}</a></td></tr>
                  ${user.company ? `<tr><td style="padding: 10px 0; color: #64748b; font-weight: 600;">Empresa</td><td style="padding: 10px 0; color: #1e293b;">${user.company}</td></tr>` : ''}
                  <tr><td style="padding: 10px 0; color: #64748b; font-weight: 600;">Categoría</td><td style="padding: 10px 0; color: #1e293b;">${catLabels[cat] || cat}</td></tr>
                </table>
                <div style="padding: 20px; background: white; border-radius: 8px; border: 1px solid #e2e8f0;">
                  <p style="color: #64748b; font-weight: 600; margin-bottom: 12px;">Mensaje:</p>
                  <p style="color: #1e293b; line-height: 1.6; margin: 0; white-space: pre-wrap;">${message}</p>
                </div>
              </div>
            </div>
          `
        }).then(() => console.log('Support email sent'))
          .catch(e => console.warn('Support email failed:', e.message));
      }
    } catch (emailErr) {
      console.warn('Support email setup failed:', emailErr.message);
    }
  } catch (err) {
    console.error('Support ticket error:', err.message);
    res.status(500).json({ error: 'Error sending support request' });
  }
});

// ====== RATE LIMITING ======
const rateLimit = new Map();
function isRateLimited(ip) {
  const now = Date.now();
  const attempts = rateLimit.get(ip) || [];
  const recent = attempts.filter(t => now - t < 60000); // 1 minute window
  rateLimit.set(ip, recent);
  if (recent.length >= 3) return true; // Max 3 per minute
  recent.push(now);
  rateLimit.set(ip, recent);
  return false;
}

// ====== CONTACT FORM API ======
app.post('/api/contact', async (req, res) => {
  try {
    // Rate limiting
    const clientIP = req.ip || req.connection.remoteAddress;
    if (isRateLimited(clientIP)) {
      return res.status(429).json({ error: 'Demasiadas solicitudes. Espera un momento.' });
    }

    const { name, email, company, workers, department, message } = req.body;

    // Validate required fields
    if (!name || !email) {
      return res.status(400).json({ error: 'Nombre y email son obligatorios' });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: 'Email no valido' });
    }

    // Sanitize HTML to prevent XSS in emails
    const esc = (str) => String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const safeName = esc(name);
    const safeEmail = esc(email);
    const safeCompany = esc(company);
    const safeWorkers = esc(workers);
    const safeDepartment = esc(department);
    const safeMessage = esc(message);

    // 1. Save lead to database (primary)
    try {
      await pool.query(
        'INSERT INTO contact_leads (name, email, company, workers, department, message) VALUES ($1, $2, $3, $4, $5, $6)',
        [name, email, company || null, workers || null, department || null, message || null]
      );
    } catch (dbErr) {
      // Table might not exist yet — create it and retry
      if (dbErr.message.includes('does not exist')) {
        await pool.query(`
          CREATE TABLE IF NOT EXISTS contact_leads (
            id SERIAL PRIMARY KEY, name VARCHAR(255) NOT NULL, email VARCHAR(255) NOT NULL,
            company VARCHAR(255), workers VARCHAR(50), department VARCHAR(255),
            message TEXT, created_at TIMESTAMP DEFAULT NOW()
          );
        `);
        await pool.query(
          'INSERT INTO contact_leads (name, email, company, workers, department, message) VALUES ($1, $2, $3, $4, $5, $6)',
          [name, email, company || null, workers || null, department || null, message || null]
        );
      } else {
        console.warn('DB insert lead failed (continuing):', dbErr.message);
      }
    }

    console.log(`Contact lead saved: ${name} <${email}> — ${company || 'N/A'}`);
    res.json({ ok: true });

    // Fire-and-forget emails (don't block response)
    try {
      if (process.env.GMAIL_APP_PASSWORD) {
        transporter.sendMail({
          from: `"Shiftia HUB" <${process.env.GMAIL_USER || 'highkeycvsender@gmail.com'}>`,
          to: process.env.SUPPORT_EMAIL || 'highkeycvsender@gmail.com',
          subject: `Nueva solicitud de demo — ${safeName} (${safeCompany || 'Sin empresa'})`,
          html: `
            <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 32px;">
              <div style="background: linear-gradient(135deg, #4ecdc4, #2980b9); padding: 24px 32px; border-radius: 12px 12px 0 0;">
                <h1 style="color: white; margin: 0; font-size: 1.4rem;">Nueva solicitud de demo</h1>
              </div>
              <div style="background: #f8fafc; padding: 32px; border: 1px solid #e2e8f0; border-top: none; border-radius: 0 0 12px 12px;">
                <table style="width: 100%; border-collapse: collapse;">
                  <tr><td style="padding: 10px 0; color: #64748b; font-weight: 600; width: 140px;">Nombre</td><td style="padding: 10px 0; color: #1e293b;">${safeName}</td></tr>
                  <tr><td style="padding: 10px 0; color: #64748b; font-weight: 600;">Email</td><td style="padding: 10px 0;"><a href="mailto:${safeEmail}" style="color: #2980b9;">${safeEmail}</a></td></tr>
                  ${safeCompany ? `<tr><td style="padding: 10px 0; color: #64748b; font-weight: 600;">Empresa</td><td style="padding: 10px 0; color: #1e293b;">${safeCompany}</td></tr>` : ''}
                  ${safeWorkers ? `<tr><td style="padding: 10px 0; color: #64748b; font-weight: 600;">Trabajadores</td><td style="padding: 10px 0; color: #1e293b;">${safeWorkers}</td></tr>` : ''}
                  ${safeDepartment ? `<tr><td style="padding: 10px 0; color: #64748b; font-weight: 600;">Departamento</td><td style="padding: 10px 0; color: #1e293b;">${safeDepartment}</td></tr>` : ''}
                </table>
                ${safeMessage ? `
                  <div style="margin-top: 20px; padding-top: 20px; border-top: 1px solid #e2e8f0;">
                    <p style="color: #64748b; font-weight: 600; margin-bottom: 8px;">Mensaje:</p>
                    <p style="color: #1e293b; line-height: 1.6; background: white; padding: 16px; border-radius: 8px; border: 1px solid #e2e8f0;">${safeMessage}</p>
                  </div>
                ` : ''}
                <p style="color: #94a3b8; font-size: 0.82rem; margin-top: 24px;">Enviado desde www.shiftia.es — ${new Date().toLocaleString('es-ES', { timeZone: 'Europe/Madrid' })}</p>
              </div>
            </div>
          `
        }).then(() => console.log('Contact notification email sent'))
          .catch(e => console.warn('Contact notification email failed:', e.message));

        transporter.sendMail({
          from: `"Shiftia" <${process.env.GMAIL_USER || 'highkeycvsender@gmail.com'}>`,
          to: email,
          subject: 'Hemos recibido tu solicitud — Shiftia',
          html: `
            <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 32px;">
              <div style="background: linear-gradient(135deg, #4ecdc4, #2980b9); padding: 24px 32px; border-radius: 12px 12px 0 0; text-align: center;">
                <h1 style="color: white; margin: 0; font-size: 1.5rem;">Shiftia</h1>
              </div>
              <div style="background: #ffffff; padding: 32px; border: 1px solid #e2e8f0; border-top: none; border-radius: 0 0 12px 12px;">
                <h2 style="color: #1e293b; margin-top: 0;">Hola ${safeName.split(' ')[0]},</h2>
                <p style="color: #475569; line-height: 1.7;">Hemos recibido tu solicitud correctamente. Nuestro equipo la revisara y te contactaremos en <strong>menos de 24 horas laborables</strong> con una propuesta personalizada.</p>
                <p style="color: #475569; line-height: 1.7;">Mientras tanto, si tienes cualquier duda, puedes responder a este email directamente.</p>
                <div style="margin: 28px 0; padding: 20px; background: #f0fdf9; border-radius: 8px; border-left: 4px solid #4ecdc4;">
                  <p style="color: #1e293b; margin: 0; font-weight: 600;">Lo que incluye tu demo:</p>
                  <ul style="color: #475569; line-height: 1.8; padding-left: 20px;">
                    <li>Configuracion con los datos de tu equipo</li>
                    <li>Demo en vivo del motor IA de coberturas</li>
                    <li>30 dias de prueba gratuita sin compromiso</li>
                  </ul>
                </div>
                <p style="color: #475569;">Un saludo,<br><strong>El equipo de Shiftia</strong></p>
              </div>
              <p style="text-align: center; color: #94a3b8; font-size: 0.78rem; margin-top: 20px;">www.shiftia.es</p>
            </div>
          `
        }).then(() => console.log('Contact confirmation email sent'))
          .catch(e => console.warn('Contact confirmation email failed:', e.message));
      }
    } catch (emailErr) {
      console.warn('Contact email setup failed:', emailErr.message);
    }

  } catch (err) {
    console.error('Contact form error:', err.message);
    res.status(500).json({ error: 'Error al enviar. Intentalo de nuevo.' });
  }
});

// ====== CALL BOOKING API ======
app.post('/api/booking', async (req, res) => {
  try {
    // Rate limiting
    const clientIP = req.ip || req.connection.remoteAddress;
    if (isRateLimited(clientIP)) {
      return res.status(429).json({ error: 'Demasiadas solicitudes. Espera un momento.' });
    }

    const { name, email, phone, company, workers, department, message, date, time } = req.body;

    // Validate required fields
    if (!name || !email || !phone || !date || !time) {
      return res.status(400).json({ error: 'Nombre, email, teléfono, fecha y hora son obligatorios' });
    }

    // Validate email
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Email no válido' });
    }

    // Validate date is weekday and not in the past
    const bookingDate = new Date(date + 'T00:00:00');
    const dow = bookingDate.getDay();
    if (dow === 0 || dow === 6) {
      return res.status(400).json({ error: 'Solo se puede agendar de lunes a viernes' });
    }

    // Validate time is 8-18
    const hour = parseInt(time.split(':')[0]);
    if (hour < 8 || hour > 18) {
      return res.status(400).json({ error: 'Horario disponible: 8:00 - 18:00' });
    }

    const esc = (str) => String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    // Save booking to database
    try {
      await pool.query(
        'INSERT INTO bookings (name, email, phone, company, workers, department, message, booking_date, booking_time) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [name, email, phone, company || null, workers || null, department || null, message || null, date, time]
      );
    } catch (dbErr) {
      if (dbErr.message.includes('does not exist')) {
        await pool.query(`
          CREATE TABLE IF NOT EXISTS bookings (
            id SERIAL PRIMARY KEY, name VARCHAR(255) NOT NULL, email VARCHAR(255) NOT NULL,
            phone VARCHAR(50) NOT NULL, company VARCHAR(255), workers VARCHAR(50),
            department VARCHAR(255), message TEXT, booking_date DATE NOT NULL,
            booking_time VARCHAR(10) NOT NULL, status VARCHAR(50) DEFAULT 'pending',
            created_at TIMESTAMP DEFAULT NOW()
          );
        `);
        await pool.query(
          'INSERT INTO bookings (name, email, phone, company, workers, department, message, booking_date, booking_time) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
          [name, email, phone, company || null, workers || null, department || null, message || null, date, time]
        );
      } else {
        console.warn('DB insert booking failed:', dbErr.message);
      }
    }

    // Format date for emails
    const dayNames = ['domingo','lunes','martes','miércoles','jueves','viernes','sábado'];
    const monthNames = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
    const prettyDate = `${dayNames[bookingDate.getDay()]} ${bookingDate.getDate()} de ${monthNames[bookingDate.getMonth()]} de ${bookingDate.getFullYear()}`;

    // Respond immediately — don't wait for emails
    console.log(`Booking: ${name} <${email}> tel:${phone} — ${date} ${time}`);
    res.json({ ok: true });

    // Fire-and-forget email notifications (don't block the response)
    try {
      if (process.env.GMAIL_APP_PASSWORD) {
        // 1. Notification to Diego
        transporter.sendMail({
          from: `"Shiftia Booking" <${process.env.GMAIL_USER || 'highkeycvsender@gmail.com'}>`,
          to: process.env.SUPPORT_EMAIL || 'highkeycvsender@gmail.com',
          subject: `📞 Nueva llamada agendada — ${esc(name)} (${esc(company || 'N/A')}) — ${prettyDate} ${time}h`,
          html: `
            <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto;">
              <div style="background: linear-gradient(135deg, #4ecdc4, #2980b9); padding: 24px 32px; border-radius: 12px 12px 0 0;">
                <h1 style="color: white; margin: 0; font-size: 1.3rem;">📞 Llamada agendada</h1>
              </div>
              <div style="background: #f8fafc; padding: 32px; border: 1px solid #e2e8f0; border-top: none; border-radius: 0 0 12px 12px;">
                <div style="background: #f0fdf9; padding: 20px; border-radius: 10px; border-left: 4px solid #4ecdc4; margin-bottom: 24px;">
                  <p style="margin: 0; font-size: 1.1rem; font-weight: 700; color: #1e293b;">📅 ${prettyDate} a las ${time}h</p>
                </div>
                <table style="width: 100%; border-collapse: collapse;">
                  <tr><td style="padding: 10px 0; color: #64748b; font-weight: 600; width: 130px;">Nombre</td><td style="padding: 10px 0; color: #1e293b;">${esc(name)}</td></tr>
                  <tr><td style="padding: 10px 0; color: #64748b; font-weight: 600;">Email</td><td style="padding: 10px 0;"><a href="mailto:${esc(email)}" style="color: #2980b9;">${esc(email)}</a></td></tr>
                  <tr><td style="padding: 10px 0; color: #64748b; font-weight: 600;">Teléfono</td><td style="padding: 10px 0; color: #1e293b; font-weight: 700;"><a href="tel:${esc(phone)}" style="color: #2980b9;">${esc(phone)}</a></td></tr>
                  ${company ? `<tr><td style="padding: 10px 0; color: #64748b; font-weight: 600;">Empresa</td><td style="padding: 10px 0; color: #1e293b;">${esc(company)}</td></tr>` : ''}
                  ${workers ? `<tr><td style="padding: 10px 0; color: #64748b; font-weight: 600;">Trabajadores</td><td style="padding: 10px 0; color: #1e293b;">${esc(workers)}</td></tr>` : ''}
                  ${department ? `<tr><td style="padding: 10px 0; color: #64748b; font-weight: 600;">Departamento</td><td style="padding: 10px 0; color: #1e293b;">${esc(department)}</td></tr>` : ''}
                </table>
                ${message ? `<div style="margin-top: 20px; padding: 16px; background: white; border-radius: 8px; border: 1px solid #e2e8f0;"><p style="color: #64748b; font-weight: 600; margin: 0 0 8px 0;">Mensaje:</p><p style="color: #1e293b; line-height: 1.6; margin: 0;">${esc(message)}</p></div>` : ''}
                <p style="color: #94a3b8; font-size: 0.82rem; margin-top: 24px;">Reservado desde shiftia.es — ${new Date().toLocaleString('es-ES', { timeZone: 'Europe/Madrid' })}</p>
              </div>
            </div>
          `
        }).then(() => console.log('Booking notification email sent'))
          .catch(e => console.warn('Booking notification email failed:', e.message));

        // 2. Confirmation to client
        transporter.sendMail({
          from: `"Shiftia" <${process.env.GMAIL_USER || 'highkeycvsender@gmail.com'}>`,
          to: email,
          subject: `Llamada confirmada — ${prettyDate} a las ${time}h — Shiftia`,
          html: `
            <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto;">
              <div style="background: linear-gradient(135deg, #4ecdc4, #2980b9); padding: 24px 32px; border-radius: 12px 12px 0 0; text-align: center;">
                <h1 style="color: white; margin: 0; font-size: 1.5rem;">Shiftia</h1>
              </div>
              <div style="background: #ffffff; padding: 32px; border: 1px solid #e2e8f0; border-top: none; border-radius: 0 0 12px 12px;">
                <h2 style="color: #1e293b; margin-top: 0;">Hola ${esc(name).split(' ')[0]},</h2>
                <p style="color: #475569; line-height: 1.7;">Tu llamada ha sido agendada correctamente. Aquí tienes los detalles:</p>
                <div style="margin: 24px 0; padding: 24px; background: linear-gradient(135deg, rgba(78,205,196,0.08), rgba(41,128,185,0.08)); border-radius: 12px; border: 1px solid rgba(78,205,196,0.2); text-align: center;">
                  <p style="margin: 0 0 4px 0; font-size: 0.85rem; color: #64748b;">Fecha y hora</p>
                  <p style="margin: 0; font-size: 1.25rem; font-weight: 700; color: #2980b9;">${prettyDate}</p>
                  <p style="margin: 4px 0 0 0; font-size: 1.5rem; font-weight: 800; color: #4ecdc4;">${time}h</p>
                </div>
                <p style="color: #475569; line-height: 1.7;">Nos pondremos en contacto contigo al teléfono <strong>${esc(phone)}</strong> o por email para coordinar los detalles de la reunión.</p>
                <p style="color: #475569; line-height: 1.7;">Si necesitas cancelar o cambiar la hora, responde a este email.</p>
                <p style="color: #475569; margin-top: 24px;">Un saludo,<br><strong>El equipo de Shiftia</strong></p>
              </div>
              <p style="text-align: center; color: #94a3b8; font-size: 0.78rem; margin-top: 20px;">www.shiftia.es</p>
            </div>
          `
        }).then(() => console.log('Booking confirmation email sent to', email))
          .catch(e => console.warn('Booking confirmation email failed:', e.message));
      }
    } catch (emailErr) {
      console.warn('Booking email setup failed:', emailErr.message);
    }

  } catch (err) {
    console.error('Booking error:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Error al agendar. Inténtalo de nuevo.' });
    }
  }
});

// ====== STATIC ROUTES ======
// Serve login.html
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Serve dashboard.html
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// Serve docs.html
app.get('/docs', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'docs.html'));
});

// Coverage notification endpoint
app.post('/api/notify', async (req, res) => {
  try {
    const { workerEmail, workerName, shift, date, absentName, acceptedBy } = req.body;

    // Configure email (console.log fallback if SMTP not configured)
    const hasEmail = process.env.SMTP_HOST;

    if (hasEmail) {
      const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: process.env.SMTP_PORT || 587,
        secure: process.env.SMTP_SECURE === 'true',
        auth: {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS
        }
      });

      const mailOptions = {
        from: process.env.SMTP_FROM || 'noreply@hospital.es',
        to: workerEmail,
        subject: `Asignación de Cobertura — Hospital de Jove`,
        html: `
          <h2>Hola ${workerName},</h2>
          <p>Se te ha asignado una cobertura por ausencia.</p>
          <table style="width:100%;border-collapse:collapse;margin:20px 0;">
            <tr style="background:#f5f5f5;">
              <td style="padding:10px;border:1px solid #ddd;"><strong>Trabajador Ausente</strong></td>
              <td style="padding:10px;border:1px solid #ddd;">${absentName}</td>
            </tr>
            <tr>
              <td style="padding:10px;border:1px solid #ddd;"><strong>Turno</strong></td>
              <td style="padding:10px;border:1px solid #ddd;">${shift}</td>
            </tr>
            <tr style="background:#f5f5f5;">
              <td style="padding:10px;border:1px solid #ddd;"><strong>Fecha</strong></td>
              <td style="padding:10px;border:1px solid #ddd;">${date}</td>
            </tr>
            <tr>
              <td style="padding:10px;border:1px solid #ddd;"><strong>Aprobado por</strong></td>
              <td style="padding:10px;border:1px solid #ddd;">${acceptedBy}</td>
            </tr>
          </table>
          <p style="color:#666;font-size:12px;">Mensaje generado automáticamente por Shiftia v5.3</p>
        `
      };

      await transporter.sendMail(mailOptions);
      res.json({ success: true, message: 'Email enviado correctamente' });
    } else {
      // Fallback: log to console if no SMTP configured
      console.log('[Email Notification]');
      console.log(`To: ${workerEmail}`);
      console.log(`Worker: ${workerName}`);
      console.log(`Coverage: ${absentName} → ${shift} on ${date}`);
      console.log(`Approved by: ${acceptedBy}`);
      res.json({ success: true, message: 'Notificación registrada (sin SMTP configurado)' });
    }
  } catch (err) {
    console.error('[Notify Error]', err);
    res.status(500).json({ error: err.message });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', version: '2.0.0', auth: 'enabled' });
});

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ====== SERVER STARTUP ======
async function startServer() {
  try {
    // Initialize database
    await initializeDatabase();

    app.listen(PORT, () => {
      console.log(`Shiftia HUB v2.0 running on port ${PORT}`);
      console.log('Authentication enabled');
      console.log(`Database connected`);
    });
  } catch (err) {
    console.error('Failed to start server:', err.message);
    process.exit(1);
  }
}

startServer();
