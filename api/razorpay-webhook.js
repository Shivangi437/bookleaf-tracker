import { createHmac } from 'crypto';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

const EVENTS_FILE = join('/tmp', 'razorpay-webhook-events.json');

function loadEvents() {
  try {
    if (existsSync(EVENTS_FILE)) {
      return JSON.parse(readFileSync(EVENTS_FILE, 'utf-8'));
    }
  } catch {}
  return [];
}

function saveEvents(events) {
  // Keep only the latest 200 events
  const trimmed = events.slice(0, 200);
  writeFileSync(EVENTS_FILE, JSON.stringify(trimmed), 'utf-8');
}

function verifySignature(body, signature, secret) {
  const expectedSignature = createHmac('sha256', secret)
    .update(body)
    .digest('hex');
  return expectedSignature === signature;
}

export default async function handler(req, res) {
  // GET — return stored webhook events
  if (req.method === 'GET') {
    const events = loadEvents();
    return res.status(200).json(events);
  }

  // POST — receive and process webhook
  if (req.method === 'POST') {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;

    // Read raw body for signature verification
    const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);

    // Verify signature if secret is configured
    if (secret) {
      const signature = req.headers['x-razorpay-signature'];
      if (!signature) {
        return res.status(401).json({ error: 'Missing X-Razorpay-Signature header' });
      }
      if (!verifySignature(rawBody, signature, secret)) {
        return res.status(401).json({ error: 'Invalid webhook signature' });
      }
    }

    const data = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const event = data.event;

    const logEntry = {
      receivedAt: new Date().toISOString(),
      event: event || 'unknown',
      processed: false,
    };

    if (event === 'payment.captured') {
      const payment = data.payload && data.payload.payment && data.payload.payment.entity;
      if (payment) {
        const amountRupees = (payment.amount || 0) / 100;
        let name = '';
        try {
          if (payment.notes && typeof payment.notes === 'object') {
            name = payment.notes.name || payment.notes.registered_name || '';
          }
        } catch {}
        if (!name && payment.card && payment.card.name) name = payment.card.name;
        if (!name) name = (payment.email || '').split('@')[0];

        logEntry.paymentId = payment.id;
        logEntry.email = (payment.email || '').toLowerCase().trim();
        logEntry.name = name.trim();
        logEntry.phone = (payment.contact || '').trim();
        logEntry.amount = amountRupees;
        logEntry.currency = payment.currency || 'INR';
        logEntry.createdAt = payment.created_at;
        logEntry.processed = true;
      }
    }

    // Append to stored events
    const events = loadEvents();
    events.unshift(logEntry);
    saveEvents(events);

    return res.status(200).json({ status: 'ok', event: logEntry.event, processed: logEntry.processed });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
