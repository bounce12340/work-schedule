import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const config = JSON.parse(readFileSync(new URL('../mobile/ios/App/App/Configuration.storekit', import.meta.url)));
const products = new Map(config.products.map(p => [p.id, p]));

test('StoreKit configuration：Pro 只有月／年兩個自動續訂商品', () => {
  assert.deepEqual([...products.keys()].sort(), [
    'com.bounceto.workschedule.pro.monthly',
    'com.bounceto.workschedule.pro.yearly',
  ]);
  assert.equal(config.subscriptionGroups.length, 1);
  assert.equal(config.subscriptionGroups[0].id, 'pro');
});

test('StoreKit configuration：價格、週期與繁中／英文商品文案正確', () => {
  const monthly = products.get('com.bounceto.workschedule.pro.monthly');
  const yearly = products.get('com.bounceto.workschedule.pro.yearly');
  assert.equal(monthly.displayPrice, '10.00');
  assert.equal(monthly.recurringSubscriptionPeriod, 'One Month');
  assert.equal(yearly.displayPrice, '100.00');
  assert.equal(yearly.recurringSubscriptionPeriod, 'One Year');
  for (const product of [monthly, yearly]) {
    assert.equal(product.productType, 'Auto-Renewable Subscription');
    assert.equal(product.subscriptionGroupID, 'pro');
    assert.deepEqual(product.localizations.map(x => x.locale).sort(), ['en_US', 'zh_TW']);
  }
});
