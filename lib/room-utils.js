function isNoneRoom(room) {
  return !room || String(room).trim().toLowerCase() === "none";
}

module.exports = { isNoneRoom };
