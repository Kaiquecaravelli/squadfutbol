/**
 * src/auth/mercadopago.js — Integração MercadoPago BettingSquad Pro
 */
import { getDb } from './database.js';
import { createPaymentRecord, activateSubscription } from './auth.js';

const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN || 'APP_USR-1571782836432355-112400-a9ddede384898f0b077cd3fd2d35b099-161373883';
const MP_PUBLIC_KEY = process.env.MP_PUBLIC_KEY || 'APP_USR-9a2bb60e-e79b-4a3e-8c12-82dde14dfa6a';
const BASE_URL = (process.env.APP_URL || '').replace(/\/$/, '') || 'http://localhost:4000';
const IS_PUBLIC_URL = !BASE_URL.includes('localhost') && !BASE_URL.includes('127.0.0.1');

export const PLANS = {
  monthly:    { name: 'Mensal',     price: 49.90,  days: 30  },
  quarterly:  { name: 'Trimestral', price: 119.90, days: 90  },
  semiannual: { name: 'Semestral',  price: 209.90, days: 180 },
  annual:     { name: 'Anual',      price: 359.90, days: 365 },
};

export async function createPaymentPreference(userId, planKey) {
  const plan = PLANS[planKey];
  if (!plan) throw new Error(`Plano inválido: ${planKey}`);

  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) throw new Error('Usuário não encontrado');

  const paymentId = createPaymentRecord(userId, planKey, plan.price);

  const body = {
    items: [{
      id: `bsq_${planKey}_${paymentId}`,
      title: `BettingSquad Pro — ${plan.name}`,
      description: `Assinatura ${plan.name} — ${plan.days} dias de acesso premium`,
      quantity: 1,
      currency_id: 'BRL',
      unit_price: plan.price,
    }],
    payer: {
      name: user.name,
      email: user.email,
    },
    back_urls: {
      success: `${BASE_URL}/subscribe?status=success&plan=${planKey}`,
      failure: `${BASE_URL}/subscribe?status=failure`,
      pending: `${BASE_URL}/subscribe?status=pending`,
    },
    // auto_return só funciona com URLs públicas — MercadoPago rejeita localhost
    ...(IS_PUBLIC_URL ? { auto_return: 'approved' } : {}),
    external_reference: String(paymentId),
    notification_url: `${BASE_URL}/api/payment/webhook`,
    metadata: {
      user_id: userId,
      plan: planKey,
      payment_record_id: paymentId,
    },
  };

  const response = await fetch('https://api.mercadopago.com/checkout/preferences', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${MP_ACCESS_TOKEN}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`MercadoPago API error ${response.status}: ${err}`);
  }

  const data = await response.json();
  return {
    preference_id: data.id,
    init_point: data.init_point,
    sandbox_init_point: data.sandbox_init_point,
    plan: plan.name,
    price: plan.price,
    days: plan.days,
    payment_record_id: paymentId,
  };
}

export async function processWebhook(data) {
  try {
    const { type, data: wData } = data;

    if (type !== 'payment') return { ok: true, skipped: true };

    const paymentId = wData?.id;
    if (!paymentId) return { ok: true, skipped: true };

    // Busca detalhes do pagamento no MP
    const response = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
      headers: { 'Authorization': `Bearer ${MP_ACCESS_TOKEN}` },
    });

    if (!response.ok) throw new Error(`MP payment fetch error: ${response.status}`);
    const payment = await response.json();

    const externalRef = payment.external_reference;
    const status = payment.status;

    if (!externalRef) return { ok: true, skipped: true };

    const db = getDb();
    const record = db.prepare('SELECT * FROM payments WHERE id = ?').get(parseInt(externalRef));
    if (!record) return { ok: true, skipped: true, reason: 'payment record not found' };

    // Atualiza status do pagamento
    db.prepare('UPDATE payments SET mp_payment_id = ?, status = ? WHERE id = ?')
      .run(String(paymentId), status, record.id);

    if (status === 'approved') {
      const plan = PLANS[record.plan];
      if (plan) {
        activateSubscription(record.user_id, record.plan, plan.days);
        console.log(`[MP] Pagamento aprovado: user_id=${record.user_id} plano=${record.plan} +${plan.days}d`);
      }
    }

    return { ok: true, processed: true, status };
  } catch (err) {
    console.error('[MP] Erro webhook:', err.message);
    return { ok: false, error: err.message };
  }
}

export { MP_PUBLIC_KEY };
