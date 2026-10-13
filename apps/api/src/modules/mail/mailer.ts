import nodemailer from 'nodemailer';
import type { Logger } from 'pino';

export interface Mail { to: string; subject: string; text: string }
export interface Mailer { send(mail: Mail): Promise<void> }

export class SmtpMailer implements Mailer {
  private t;
  constructor(url: string, private from: string) { this.t = nodemailer.createTransport(url); }
  async send(m: Mail) { await this.t.sendMail({ from: this.from, ...m }); }
}

/** Development only: prints mail (including reset links) to the log. Never used in production. */
export class ConsoleMailer implements Mailer {
  constructor(private log: Logger) {}
  async send(m: Mail) { this.log.info({ to: m.to, subject: m.subject, text: m.text }, 'DEV MAIL (not sent)'); }
}

export class UnconfiguredMailer implements Mailer {
  async send(): Promise<never> { throw new Error('No SMTP_URL configured'); }
}

/** Test helper. */
export class CaptureMailer implements Mailer {
  sent: Mail[] = [];
  async send(m: Mail) { this.sent.push(m); }
}
