import { randomUUID } from 'node:crypto';

const DEFAULT_LIFETIME_MS = 5 * 60 * 1000;

interface DestinationGrant {
  readonly authorization: string;
  readonly destination: string;
  readonly expiresAt: number;
  readonly request: string;
}

function requestFingerprint(request: unknown): string {
  // Disclosure consent is obtained at Export, after the native folder picker.
  // Its independent authority binds the disclosure request and selection.
  return JSON.stringify(request, (key: string, value: unknown) => (key === 'consent' ? undefined : value));
}

/** One-use proof that a renderer chose a destination through main's native picker. */
export class ExportDestinationAuthority {
  readonly #bySender = new Map<number, DestinationGrant>();

  constructor(private readonly lifetimeMs = DEFAULT_LIFETIME_MS) {}

  issue(senderId: number, request: unknown, destination: string, now = Date.now()): string {
    this.#prune(now);
    const authorization = randomUUID();
    this.#bySender.set(senderId, {
      authorization,
      destination,
      expiresAt: now + this.lifetimeMs,
      request: requestFingerprint(request),
    });
    return authorization;
  }

  consume(senderId: number, request: unknown, authorization: string, now = Date.now()): string {
    this.#prune(now);
    const grant = this.#bySender.get(senderId);
    if (grant?.authorization !== authorization || grant.request !== requestFingerprint(request)) {
      throw new Error('export destination authorization is invalid or expired');
    }
    this.#bySender.delete(senderId);
    return grant.destination;
  }

  revoke(senderId: number, authorization: string, now = Date.now()): boolean {
    this.#prune(now);
    const grant = this.#bySender.get(senderId);
    if (grant?.authorization !== authorization) return false;
    this.#bySender.delete(senderId);
    return true;
  }

  #prune(now: number): void {
    for (const [senderId, grant] of this.#bySender) {
      if (grant.expiresAt <= now) this.#bySender.delete(senderId);
    }
  }
}
