import type { OutboundEmail } from './mailer.ts';

/**
 * Plain, short emails. Both a text and an HTML part, because a verification link that
 * lands in a text-only client and shows raw markup reads as a phishing attempt.
 */
function layout(heading: string, body: string, action: { label: string; url: string }): string {
  return `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f6f6f4;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;color:#1c1c1a">
  <div style="max-width:480px;margin:0 auto;background:#fff;border-radius:10px;padding:28px">
    <h1 style="margin:0 0 12px;font-size:19px">${heading}</h1>
    <p style="margin:0 0 20px;font-size:15px;line-height:1.5">${body}</p>
    <a href="${action.url}" style="display:inline-block;background:#1f6f43;color:#fff;text-decoration:none;padding:11px 20px;border-radius:7px;font-size:15px;font-weight:600">${action.label}</a>
    <p style="margin:22px 0 0;font-size:13px;color:#6b6b66;line-height:1.5">
      If the button does not work, paste this into your browser:<br>
      <span style="word-break:break-all">${action.url}</span>
    </p>
  </div>
</body></html>`;
}

export function verificationEmail(to: string, url: string): OutboundEmail {
  return {
    to,
    subject: 'Confirm your email address',
    text: `Confirm your email address to finish setting up your Divot Diggers account.\n\n${url}\n\nIf you did not create an account, you can ignore this message.`,
    html: layout(
      'Confirm your email address',
      'One click and your Divot Diggers account is ready. If you did not create an account, you can ignore this message.',
      { label: 'Confirm email', url },
    ),
  };
}

export function passwordResetEmail(to: string, url: string): OutboundEmail {
  return {
    to,
    subject: 'Reset your password',
    text: `Use this link to set a new password. It expires in one hour and can only be used once.\n\n${url}\n\nIf you did not ask to reset your password, you can ignore this message and nothing will change.`,
    html: layout(
      'Reset your password',
      'Use the link below to set a new password. It expires in one hour and can only be used once. If you did not ask for this, ignore this message and nothing will change.',
      { label: 'Set a new password', url },
    ),
  };
}
