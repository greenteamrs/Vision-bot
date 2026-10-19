const LOCK_KEY_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,239}$/;

function isValidDashboardLockKey(key) {
  return typeof key === 'string' && LOCK_KEY_PATTERN.test(key);
}

function isDashboardLockEnforced(role, locked) {
  return role !== 'admin' && locked === true;
}

function valuesDiffer(left, right) {
  if (left instanceof Date || right instanceof Date) {
    const leftTime = left instanceof Date ? left.getTime() : new Date(left).getTime();
    const rightTime = right instanceof Date ? right.getTime() : new Date(right).getTime();
    return leftTime !== rightTime;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return true;
    return left.some((value, index) => valuesDiffer(value, right[index]));
  }
  if (left && right && typeof left === 'object' && typeof right === 'object') {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    if (leftKeys.length !== rightKeys.length || leftKeys.some((key, index) => key !== rightKeys[index])) return true;
    return leftKeys.some(key => valuesDiffer(left[key], right[key]));
  }
  return !Object.is(left, right);
}

module.exports = {
  isValidDashboardLockKey,
  isDashboardLockEnforced,
  valuesDiffer,
};
