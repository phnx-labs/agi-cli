import { describe, it, expect } from 'vitest';
import { computeActor, actorEnv, actorFromIdentity, actorAvatar, type ResolvedActor } from './actor.js';

describe('computeActor', () => {
  it('inherits an actor an ancestor stamped into the env, without re-resolving', () => {
    const env: NodeJS.ProcessEnv = {
      AGENTS_ACTOR: 'bisma@example.com',
      AGENTS_ACTOR_KIND: 'human',
      AGENTS_ACTOR_NAME: 'Bisma',
      AGENTS_ACTOR_EMAIL: 'bisma@example.com',
      AGENTS_ACTOR_GITHUB: 'bisma',
      SSH_CONNECTION: '100.64.0.9 51000 100.64.0.1 22',
    };
    expect(computeActor(env)).toEqual<ResolvedActor>({
      id: 'bisma@example.com',
      kind: 'human',
      name: 'Bisma',
      email: 'bisma@example.com',
      github: 'bisma',
    });
  });

  it('inherits kind=agent verbatim', () => {
    const actor = computeActor({ AGENTS_ACTOR: 'scout', AGENTS_ACTOR_KIND: 'agent' });
    expect(actor.id).toBe('scout');
    expect(actor.kind).toBe('agent');
  });

  const noTailscale = { whois: () => undefined, self: () => undefined, session: () => null };

  it('falls back to UNRESOLVED@<host> for a local run when tailscale names no owner', () => {
    const actor = computeActor({}, noTailscale);
    expect(actor.id).toMatch(/^UNRESOLVED@/);
    expect(actor.kind).toBe('human');
    expect(actor.email).toBeUndefined();
    expect(actor.name).toBeUndefined();
  });

  it('credits the device`s own tailnet owner for a local (non-SSH) run', () => {
    const actor = computeActor({}, {
      whois: () => undefined,
      self: () => ({ login: 'muqsitnawaz@gmail.com', displayName: 'Muqsit' }),
      session: () => null,
    });
    expect(actor.id).toBe('muqsitnawaz@gmail.com');
    expect(actor.name).toBe('Muqsit');
    expect(actor.email).toBe('muqsitnawaz@gmail.com');
  });

  it('does not self-credit an SSH run whose whois fails (no misattribution to the box owner)', () => {
    const actor = computeActor(
      { SSH_CONNECTION: '100.64.0.9 51000 100.64.0.1 22' },
      { whois: () => undefined, self: () => ({ login: 'boxowner@example.com' }), session: () => null },
    );
    expect(actor.id).toMatch(/^UNRESOLVED@/);
  });

  it('does not shell out (whois or self) when SSH_CONNECTION is present but malformed', () => {
    const actor = computeActor(
      { SSH_CONNECTION: 'garbage' },
      { whois: () => ({ login: 'x' }), self: () => ({ login: 'boxowner@example.com' }), session: () => null },
    );
    expect(actor.id).toMatch(/^UNRESOLVED@/);
  });
});

describe('actorFromIdentity (the SSH-resolved enrich/override path)', () => {
  const whoMuqsit = { login: 'muqsitnawaz@gmail.com', displayName: 'Muqsit' };

  it('credits git straight from the tailnet identity when there is no actors entry', () => {
    expect(actorFromIdentity(whoMuqsit, 'yosemite-s1', {})).toEqual<ResolvedActor>({
      id: 'muqsitnawaz@gmail.com',
      kind: 'human',
      name: 'Muqsit',
      email: 'muqsitnawaz@gmail.com',
      github: undefined,
    });
  });

  it('enriches + overrides from an actors entry matched by map key', () => {
    const actors = {
      'muqsitnawaz@gmail.com': { name: 'Muqsit Nawaz', email: 'muqsit@company.com', github: 'muqsitnawaz' },
    };
    const actor = actorFromIdentity(whoMuqsit, 'h', actors);
    expect(actor.name).toBe('Muqsit Nawaz');
    expect(actor.email).toBe('muqsit@company.com');
    expect(actor.github).toBe('muqsitnawaz');
    expect(actor.id).toBe('muqsitnawaz@gmail.com');
  });

  it('matches an entry by its explicit login field, case-insensitively', () => {
    const actors = { bisma: { login: 'BISMA@EXAMPLE.COM', name: 'Bisma', email: 'bisma@example.com' } };
    const actor = actorFromIdentity({ login: 'bisma@example.com' }, 'h', actors);
    expect(actor.name).toBe('Bisma');
    expect(actor.email).toBe('bisma@example.com');
  });

  it('matches an entry by its email field', () => {
    const actors = { b: { email: 'bisma@example.com', github: 'bee' } };
    const actor = actorFromIdentity({ login: 'bisma@example.com' }, 'h', actors);
    expect(actor.github).toBe('bee');
  });

  it('carries the phoenixId from a matched actors entry (personal login -> work identity)', () => {
    const actors = { 'muqsitnawaz@gmail.com': { email: 'muqsit@getrush.ai', phoenixId: 'muqsit' } };
    const actor = actorFromIdentity(whoMuqsit, 'h', actors);
    expect(actor.phoenixId).toBe('muqsit');
    expect(actor.id).toBe('muqsitnawaz@gmail.com');
  });

  it('leaves phoenixId undefined for a login with no actors entry', () => {
    expect(actorFromIdentity(whoMuqsit, 'h', {}).phoenixId).toBeUndefined();
  });

  it('honors a kind: agent override (so an agent identity gets no personal git credit)', () => {
    const actors = { scout: { login: 'scout@bots', kind: 'agent' as const, name: 'Scout', email: 'scout@bots' } };
    const actor = actorFromIdentity({ login: 'scout@bots' }, 'h', actors);
    expect(actor.kind).toBe('agent');
    expect(actorEnv(actor).GIT_AUTHOR_NAME).toBeUndefined();
  });

  it('leaves email undefined for a non-email login with no config (no git credit)', () => {
    const actor = actorFromIdentity({ login: 'plainuser', displayName: 'Plain' }, 'h', {});
    expect(actor.email).toBeUndefined();
    expect(actorEnv(actor).GIT_AUTHOR_EMAIL).toBeUndefined();
  });

  it('falls back to UNRESOLVED@<host> when whois names no one', () => {
    expect(actorFromIdentity(undefined, 'zion', {})).toEqual<ResolvedActor>({ id: 'UNRESOLVED@zion', kind: 'human' });
  });
});

describe('actorEnv', () => {
  it('credits git for a resolved human with a real name + email', () => {
    const env = actorEnv({
      id: 'muqsitnawaz@gmail.com',
      kind: 'human',
      name: 'Muqsit',
      email: 'muqsitnawaz@gmail.com',
    });
    expect(env.AGENTS_ACTOR).toBe('muqsitnawaz@gmail.com');
    expect(env.AGENTS_ACTOR_KIND).toBe('human');
    expect(env.GIT_AUTHOR_NAME).toBe('Muqsit');
    expect(env.GIT_AUTHOR_EMAIL).toBe('muqsitnawaz@gmail.com');
    expect(env.GIT_COMMITTER_NAME).toBe('Muqsit');
    expect(env.GIT_COMMITTER_EMAIL).toBe('muqsitnawaz@gmail.com');
  });

  it('claims no git identity for an unresolved actor (keeps ambient git config)', () => {
    const env = actorEnv({ id: 'UNRESOLVED@zion', kind: 'human' });
    expect(env.AGENTS_ACTOR).toBe('UNRESOLVED@zion');
    expect(env.AGENTS_ACTOR_KIND).toBe('human');
    expect(env.GIT_AUTHOR_NAME).toBeUndefined();
    expect(env.GIT_AUTHOR_EMAIL).toBeUndefined();
    expect(env.GIT_COMMITTER_NAME).toBeUndefined();
    expect(env.GIT_COMMITTER_EMAIL).toBeUndefined();
  });

  it('does not give a non-human actor personal git credit', () => {
    const env = actorEnv({ id: 'scout', kind: 'agent', name: 'Scout', email: 'scout@bot' });
    expect(env.AGENTS_ACTOR_KIND).toBe('agent');
    expect(env.GIT_AUTHOR_NAME).toBeUndefined();
    expect(env.GIT_AUTHOR_EMAIL).toBeUndefined();
  });

  it('propagates phoenixId and round-trips it back through inheritance', () => {
    const actor: ResolvedActor = {
      id: 'muqsitnawaz@gmail.com',
      kind: 'human',
      name: 'Muqsit',
      email: 'muqsit@getrush.ai',
      phoenixId: 'muqsit',
    };
    const env = actorEnv(actor);
    expect(env.AGENTS_ACTOR_PHOENIX_ID).toBe('muqsit');
    expect(computeActor(env)).toEqual(actor);
  });

  it('propagates the Phoenix avatar and round-trips it back through inheritance', () => {
    const actor: ResolvedActor = {
      id: 'muqsitnawaz@gmail.com',
      kind: 'human',
      name: 'Muqsit',
      email: 'muqsitnawaz@gmail.com',
      avatarUrl: 'https://lh3.googleusercontent.com/a/abc=s96-c',
    };
    const env = actorEnv(actor);
    expect(env.AGENTS_ACTOR_AVATAR).toBe('https://lh3.googleusercontent.com/a/abc=s96-c');
    expect(computeActor(env)).toEqual(actor);
    expect(computeActor({ ...env, AGENTS_ACTOR_AVATAR: 'javascript:alert(1)' }).avatarUrl).toBeUndefined();
  });

  it('round-trips through the env: actorEnv output re-inherits to the same actor', () => {
    const actor: ResolvedActor = {
      id: 'bisma@example.com',
      kind: 'human',
      name: 'Bisma',
      email: 'bisma@example.com',
      github: 'bisma',
    };
    expect(computeActor(actorEnv(actor))).toEqual(actor);
  });

  it('two different resolved actors produce two different forwarded git identities', () => {
    const alice = actorEnv(computeActor({
      AGENTS_ACTOR: 'alice@example.com', AGENTS_ACTOR_KIND: 'human',
      AGENTS_ACTOR_NAME: 'Alice', AGENTS_ACTOR_EMAIL: 'alice@example.com',
    }));
    const bob = actorEnv(computeActor({
      AGENTS_ACTOR: 'bob@example.com', AGENTS_ACTOR_KIND: 'human',
      AGENTS_ACTOR_NAME: 'Bob', AGENTS_ACTOR_EMAIL: 'bob@example.com',
    }));
    expect(alice.AGENTS_ACTOR).toBe('alice@example.com');
    expect(alice.GIT_AUTHOR_NAME).toBe('Alice');
    expect(alice.GIT_AUTHOR_EMAIL).toBe('alice@example.com');
    expect(bob.AGENTS_ACTOR).toBe('bob@example.com');
    expect(bob.GIT_AUTHOR_NAME).toBe('Bob');
    expect(bob.GIT_AUTHOR_EMAIL).toBe('bob@example.com');
    expect(alice.GIT_AUTHOR_EMAIL).not.toBe(bob.GIT_AUTHOR_EMAIL);
  });
});

describe('actorAvatar', () => {
  const session = { access_token: 't', email: 'Muqsit@Example.com', avatarUrl: 'https://lh3.googleusercontent.com/a/abc=s96-c' };
  const human: ResolvedActor = { id: 'muqsit@example.com', kind: 'human', name: 'Muqsit', email: 'muqsit@example.com' };

  it('lends the signed-in Phoenix picture to the same person, matching email case-insensitively', () => {
    expect(actorAvatar(human, session)).toBe('https://lh3.googleusercontent.com/a/abc=s96-c');
  });

  it('never lends the picture to a different person, an agent, or an unresolved actor', () => {
    expect(actorAvatar({ ...human, email: 'bisma@example.com' }, session)).toBeUndefined();
    expect(actorAvatar({ ...human, kind: 'agent' }, session)).toBeUndefined();
    expect(actorAvatar({ id: 'UNRESOLVED@zion', kind: 'human' }, session)).toBeUndefined();
    expect(actorAvatar(human, null)).toBeUndefined();
    expect(actorAvatar(human, { ...session, avatarUrl: undefined })).toBeUndefined();
    expect(actorAvatar(human, { ...session, avatarUrl: 'http://insecure.example/a.png' })).toBeUndefined();
  });

  it('is attached by computeActor for a local run whose box owner is the signed-in person', () => {
    const actor = computeActor(
      { AGENTS_ACTOR: undefined, SSH_CONNECTION: undefined },
      { whois: () => undefined, self: () => ({ login: 'muqsit@example.com', displayName: 'Muqsit' }), session: () => session },
    );
    expect(actor.email).toBe('muqsit@example.com');
    expect(actor.avatarUrl).toBe('https://lh3.googleusercontent.com/a/abc=s96-c');
    expect(actorEnv(actor).AGENTS_ACTOR_AVATAR).toBe('https://lh3.googleusercontent.com/a/abc=s96-c');
  });
});
