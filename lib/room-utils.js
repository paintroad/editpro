function isNoneRoom(room) {
  const normalized = String(room || "").trim().toLowerCase();
  return !normalized || normalized === "none" || normalized === "null" || normalized === "other";
}

module.exports = { isNoneRoom };
