/** Express middleware: authenticate care platform users from Bearer access token. */
const { AppError } = require('./appError');
const { verifyAccessToken } = require('./crypto');

function requireCareUser(allowedRoles = []) {
  return (req, _res, next) => {
    try {
      const header = String(req.headers.authorization || '');
      const token = header.startsWith('Bearer ') ? header.slice(7) : null;
      if (!token) {
        throw new AppError('UNAUTHORIZED', 'กรุณาเข้าสู่ระบบ', 401);
      }
      const payload = verifyAccessToken(token);
      if (allowedRoles.length && !allowedRoles.includes(payload.role)) {
        throw new AppError('FORBIDDEN', 'ไม่มีสิทธิ์เข้าถึงส่วนนี้', 403);
      }
      req.careUser = { id: payload.sub, role: payload.role, phone: payload.phone };
      next();
    } catch (err) {
      next(err);
    }
  };
}

module.exports = { requireCareUser };
