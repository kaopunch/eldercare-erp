/**
 * SmsProvider interface (DECISIONS.md 2026-06-11): real provider can replace the
 * mock later without touching the OTP flow. A provider implements:
 *   async sendSms(phoneE164, message) -> { provider, accepted: boolean }
 */

class MockSmsProvider {
  constructor() {
    this.name = 'mock';
    /** test hook: last messages sent, newest last */
    this.sent = [];
  }

  async sendSms(phoneE164, message) {
    this.sent.push({ phone: phoneE164, message, at: new Date().toISOString() });
    if (process.env.NODE_ENV !== 'production') {
      // dev only: surface OTP in server log for manual testing — never in production
      console.log(`[mock-sms] to=${phoneE164}: ${message}`);
    }
    return { provider: this.name, accepted: true };
  }
}

let activeProvider = null;

function getSmsProvider() {
  if (!activeProvider) {
    // future: switch on process.env.CARE_SMS_PROVIDER ('thaibulksms', ...)
    activeProvider = new MockSmsProvider();
  }
  return activeProvider;
}

/** test hook */
function setSmsProvider(provider) {
  activeProvider = provider;
}

module.exports = { MockSmsProvider, getSmsProvider, setSmsProvider };
