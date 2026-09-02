export interface OutboundEmail {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

export interface Mailer {
  send(email: OutboundEmail): Promise<void>;
}

/**
 * Sends through Mailgun's HTTP API.
 *
 * Deliberately not SMTP: a failed HTTP call gives a status code and a message body that
 * can be logged, where an SMTP timeout gives very little.
 */
export function createMailgunMailer(options: {
  apiKey: string;
  domain: string;
  from: string;
  /** Mailgun's EU region uses a different host. */
  region?: 'us' | 'eu';
}): Mailer {
  const host = options.region === 'eu' ? 'api.eu.mailgun.net' : 'api.mailgun.net';
  const endpoint = `https://${host}/v3/${options.domain}/messages`;

  return {
    async send(email) {
      const body = new URLSearchParams({
        from: options.from,
        to: email.to,
        subject: email.subject,
        text: email.text,
        html: email.html,
      });

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`api:${options.apiKey}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(
          `Mailgun rejected the message to ${email.to}: HTTP ${response.status}. ${detail.slice(0, 300)}`,
        );
      }
    },
  };
}

/** Captures instead of sending, so tests can read the link out of an email. */
export interface CapturingMailer extends Mailer {
  readonly sent: readonly OutboundEmail[];
  lastTo(address: string): OutboundEmail | undefined;
  clear(): void;
}

export function createCapturingMailer(): CapturingMailer {
  const sent: OutboundEmail[] = [];
  return {
    sent,
    async send(email) {
      sent.push(email);
    },
    lastTo(address) {
      return [...sent].reverse().find((email) => email.to === address);
    },
    clear() {
      sent.length = 0;
    },
  };
}
