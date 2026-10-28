import type { NativeOperation, SendReceipt } from '../../../packages/shared/protocol';

// An acknowledged original send identifies the same running Turn. It blocks a
// new Turn, but does not make a supplemental instruction an uncertain resend.
export function steerDeliveryBlocked(sendBlocked: boolean, receipts: SendReceipt[], activeTurn: string | undefined, acceptedReview = false) {
  if (!sendBlocked) return false;
  const unresolved = receipts.filter(receipt => receipt.status === 'unknown' || receipt.status === 'accepted');
  return !activeTurn || !unresolved.length && !acceptedReview || unresolved.some(receipt => receipt.status !== 'accepted' || receipt.turnId !== activeTurn);
}

export function steerOperationBlocked(operations: NativeOperation[], activeTurn: string | undefined) {
  return operations.some(operation => operation.state === 'running' || (['accepted', 'unknown'].includes(operation.state)
    && ['review/start', 'thread/compact/start', 'thread/revert', 'turn/steer'].includes(operation.method)
    && !(operation.state === 'accepted' && operation.method === 'review/start' && operation.turnId === activeTurn && !!activeTurn)));
}
