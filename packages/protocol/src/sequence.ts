export function compareSequence(left: bigint, right: bigint): -1 | 0 | 1 {
  if (left < right) {
    return -1;
  }

  if (left > right) {
    return 1;
  }

  return 0;
}

export function isNextSequence(previous: bigint, next: bigint): boolean {
  return next === previous + 1n;
}
