import './../setup';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseIpv4, parseIpv6, parseIpLiteral, isBlockedIpLiteral } from '../../src/security/ip';
import { isBlockedHostname, quickBlockCheck } from '../../src/security/ssrf';

test('IPv4 各种写法都能被解析为 127.0.0.1', () => {
  assert.deepEqual(parseIpv4('127.0.0.1'), [127, 0, 0, 1]);
  assert.deepEqual(parseIpv4('127.1'), [127, 0, 0, 1]);
  assert.deepEqual(parseIpv4('2130706433'), [127, 0, 0, 1]);
  assert.deepEqual(parseIpv4('0x7f000001'), [127, 0, 0, 1]);
  assert.deepEqual(parseIpv4('0177.0.0.01'), [127, 0, 0, 1]);
});

test('私网 / 回环 / metadata IPv4 全部被拦截', () => {
  for (const ip of [
    '127.0.0.1', '127.1', '2130706433', '0x7f000001',
    '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.169.254',
    '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255',
  ]) {
    assert.equal(isBlockedIpLiteral(ip), true, `${ip} 应被拦截`);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34']) {
    assert.equal(isBlockedIpLiteral(ip), false, `${ip} 不应被拦截`);
  }
});

test('IPv6 回环与唯一本地地址被拦截', () => {
  assert.equal(isBlockedIpLiteral('::1'), true);
  assert.equal(isBlockedIpLiteral('[::1]'), true);
  assert.equal(isBlockedIpLiteral('fd00::1'), true);
  assert.equal(isBlockedIpLiteral('fe80::1'), true);
  assert.equal(isBlockedIpLiteral('::ffff:127.0.0.1'), true);
  assert.equal(isBlockedIpLiteral('64:ff9b::127.0.0.1'), true);
  assert.equal(isBlockedIpLiteral('2002:7f00:1::'), true);
});

test('IPv6 解析正确', () => {
  const b = parseIpv6('2001:db8::1');
  assert.ok(b);
  assert.equal(b[0], 0x20);
  assert.equal(b[1], 0x01);
  assert.equal(b[15], 0x01);
  assert.ok(parseIpLiteral('2001:db8::1'));
});

test('localhost 与 .internal 域名被拦截', () => {
  assert.equal(isBlockedHostname('localhost'), true);
  assert.equal(isBlockedHostname('LOCALHOST'), true);
  assert.equal(isBlockedHostname('metadata.google.internal'), true);
  assert.equal(isBlockedHostname('foo.internal'), true);
  assert.equal(isBlockedHostname('printer.local'), true);
  assert.equal(isBlockedHostname('example.com'), false);
});

test('提交阶段快速拦截 localhost 与私网字面量', () => {
  assert.equal(quickBlockCheck('localhost').ok, false);
  assert.equal(quickBlockCheck('127.0.0.1').ok, false);
  assert.equal(quickBlockCheck('169.254.169.254').ok, false);
  assert.equal(quickBlockCheck('example.com').ok, true);
});
