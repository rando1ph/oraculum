import { expect, it } from 'vitest';
import type { NativeOperation, SendReceipt } from '../../../packages/shared/protocol';
import { steerDeliveryBlocked, steerOperationBlocked } from './native-controls';
const accepted: SendReceipt = { operationId: 'send', status: 'accepted', turnId: 'active-turn', createdAt: 1 };
it('permits supplemental input after an acknowledged original send to the same observed Turn', () => {
  expect(steerDeliveryBlocked(true, [accepted], 'active-turn')).toBe(false);
  expect(steerDeliveryBlocked(false, [], 'active-turn')).toBe(false);
});
it('keeps unknown sends, mismatched Turns, and unexplained delivery blocks closed', () => {
  expect(steerDeliveryBlocked(true, [{ ...accepted, status: 'unknown' }], 'active-turn')).toBe(true);
  expect(steerDeliveryBlocked(true, [accepted], 'new-turn')).toBe(true);
  expect(steerDeliveryBlocked(true, [accepted], undefined)).toBe(true);
  expect(steerDeliveryBlocked(true, [], 'active-turn')).toBe(true);
  expect(steerDeliveryBlocked(true, [accepted, { ...accepted, operationId: 'unknown', status: 'unknown', turnId: null }], 'active-turn')).toBe(true);
});

it('permits supplements to the acknowledged active native Review while retaining mutation uncertainty gates', () => {
  const review: NativeOperation = { operationId: 'review', threadId: 'thread', cwd: '/project', method: 'review/start', state: 'accepted', createdAt: 1, turnId: 'review-turn' };
  expect(steerDeliveryBlocked(true, [], 'review-turn', true)).toBe(false);
  expect(steerDeliveryBlocked(true, [{ ...accepted, status: 'unknown', turnId: null }], 'review-turn', true)).toBe(true);
  expect(steerOperationBlocked([review], 'review-turn')).toBe(false);
  expect(steerOperationBlocked([review], 'other-turn')).toBe(true);
  expect(steerOperationBlocked([{ ...review, state: 'unknown' }], 'review-turn')).toBe(true);
  expect(steerOperationBlocked([{ ...review, state: 'running' }], 'review-turn')).toBe(true);
  expect(steerOperationBlocked([{ ...review, method: 'thread/compact/start' }], 'review-turn')).toBe(true);
  expect(steerOperationBlocked([{ ...review, method: 'thread/name/set', state: 'unknown' }], 'review-turn')).toBe(false);
});
