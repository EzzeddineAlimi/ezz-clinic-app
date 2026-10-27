import test from 'node:test';
import assert from 'node:assert/strict';
import { Clinic } from '../src/clinic.ts';
function setup(){const c=new Clinic();const p=c.addPatient('FICTIONAL','000');const a=c.addAppointment(p.id,'2026-10-28T09:00');return {c,a};}
test('payment requires independently confirmed treatment',()=>{const {c,a}=setup();assert.throws(()=>c.pay(a.id,1000,'cash'),/not confirmed/);});
test('partial payment leaves precise remaining credit',()=>{const {c,a}=setup();c.confirmCare(a.id,'Checkup',100000);c.pay(a.id,70000,'cash');assert.equal(c.balance(a.id),30000);});
test('receipt numbers are sequential and preserved',()=>{const {c,a}=setup();c.confirmCare(a.id,'Checkup',100000);assert.equal(c.pay(a.id,70000,'cash').receiptNo,1);assert.equal(c.pay(a.id,30000,'card').receiptNo,2);assert.equal(c.events.filter(e=>e.action==='payment_recorded').length,2);});
test('overpayment cannot be accepted',()=>{const {c,a}=setup();c.confirmCare(a.id,'Checkup',100000);assert.throws(()=>c.pay(a.id,100001,'cash'),/exceed balance/);});
test('cash discrepancy found independent of card payments',()=>{const {c,a}=setup();c.confirmCare(a.id,'Checkup',100000);c.pay(a.id,70000,'cash');c.pay(a.id,30000,'card');assert.deepEqual(c.countCash(60000).differenceMillimes,-10000);});
test('cannot edit care confirmation twice',()=>{const {c,a}=setup();c.confirmCare(a.id,'Checkup',100000);assert.throws(()=>c.confirmCare(a.id,'Other',1),/already confirmed/);});
test('invalid payment amount rejected',()=>{const {c,a}=setup();c.confirmCare(a.id,'Checkup',100000);assert.throws(()=>c.pay(a.id,-1,'cash'),/positive/);});
