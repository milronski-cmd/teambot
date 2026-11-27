import { test } from 'node:test';
import assert from 'node:assert/strict';
import { movesMoney, riskFromAnnotations } from '../server/modules/mcp/risk.js';
import { appToolImpact, appToolRisk } from '../server/modules/cli-agents/permissions.js';
import { Broker } from '../server/tools/broker.js';

// Money moved through a connector (Stripe, Mollie, PayPal …) is a payment: the bot may prepare it, the owner says yes.
const MONEY = ['create_refund', 'cancel_subscription', 'create_payment_link', 'finalize_invoice', 'capture_order_payment', 'createPayout', 'update_subscription', 'send_invoice'];
const LOOKUPS = ['list_refunds', 'retrieve_balance', 'get_payment_intent', 'list_subscriptions', 'search_invoices', 'list_customers', 'create_customer'];

test('movesMoney: money actions yes, lookups and non-money no', () => {
  for (const n of MONEY) assert.equal(movesMoney(n), true, n);
  for (const n of LOOKUPS) assert.equal(movesMoney(n), false, n);
  assert.equal(movesMoney('get_and_refund_payment'), true, 'a read start with an act word still moves money');
});

test('connector money tools are danger, even when the server says read-only', () => {
  for (const n of MONEY) assert.equal(riskFromAnnotations({}, n), 'danger', n);
  assert.equal(riskFromAnnotations({ readOnlyHint: true }, 'create_refund'), 'danger');
  assert.equal(riskFromAnnotations({ readOnlyHint: true }, 'list_refunds'), 'read');
});

test('engine app tools (Claude Code connectors): money is danger with impact payment', () => {
  for (const n of MONEY) {
    assert.equal(appToolRisk(`mcp__stripe__${n}`, {}), 'danger', n);
    assert.equal(appToolImpact(`mcp__stripe__${n}`), 'payment', n);
  }
});

test('Volledige toegang with fullAccessExternal: everything runs, payments still ask', () => {
  const broker = new Broker(() => ({ services: {} }) as any);
  const agent: any = { access_mode: 'full', tool_policy: {}, settings: { fullAccessExternal: true } };
  assert.equal(broker.decide(agent, { name: 'mcp_stripe_create_refund', risk: 'danger', impact: 'payment' }), 'ask');
  assert.equal(broker.decide(agent, { name: 'mcp_gmail_send', risk: 'danger' }), 'allow');
  assert.equal(broker.decide(agent, { name: 'mcp_stripe_create_customer', risk: 'write' }), 'allow');
});
