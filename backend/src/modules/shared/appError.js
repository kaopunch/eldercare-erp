/**
 * AppError — central error type for care platform modules.
 * The /api/v1 error handler turns this into JSON {code, message} (message in Thai).
 */
class AppError extends Error {
  /**
   * @param {string} code machine-readable error code (UPPER_SNAKE)
   * @param {string} messageTh user-facing Thai message
   * @param {number} [statusCode]
   * @param {object} [details]
   */
  constructor(code, messageTh, statusCode = 400, details = undefined) {
    super(messageTh);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

module.exports = { AppError };
