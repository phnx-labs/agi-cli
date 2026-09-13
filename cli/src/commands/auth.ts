import type { Command } from 'commander';
import chalk from 'chalk';

import {
  PhoenixApiError,
  clearSession,
  createSpace,
  createSpaceInvite,
  fetchWhoAmI,
  listSpaceMembers,
  listSpaces,
  pollDeviceToken,
  readSession,
  refreshSessionAvatar,
  removeSpaceMember,
  resolveMemberFromList,
  resolveSpaceFromList,
  slugify,
  startDeviceAuthorization,
  updateSpaceMemberRole,
  writeSession,
} from '../lib/identity/index.js';
import { setHelpSections } from '../lib/help.js';
import { runOrDie } from '../lib/format.js';

/**
 * `agents auth` — sign in to Phoenix ID, the account layer behind team spaces.
 * Signing in is optional: every local feature works with no account. Everything
 * here goes through `lib/identity`; this file builds no URLs and reads no
 * credential files of its own.
 */

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function login(): Promise<void> {
  const grant = await startDeviceAuthorization();
  console.log('');
  console.log(`  Your code:  ${chalk.bold.cyan(grant.user_code)}`);
  console.log(`  Open:       ${chalk.underline(grant.verification_uri_complete)}`);
  console.log('');
  console.log(chalk.gray('  Waiting for you to approve it in the browser…'));

  // The server sets the pace; `slow_down` widens it (RFC 8628 §3.5).
  let interval = Math.max(1, grant.interval) * 1000;
  const deadline = Date.now() + grant.expires_in * 1000;

  while (Date.now() < deadline) {
    await sleep(interval);
    const poll = await pollDeviceToken(grant.device_code);
    if (poll.status === 'authorized') {
      const avatarUrl = poll.user.avatar_url ?? poll.user.picture;
      writeSession({
        access_token: poll.access_token,
        email: poll.user.email,
        userId: poll.user.id,
        ...(avatarUrl ? { avatarUrl } : {}),
      });
      console.log(chalk.green(`\n  Signed in as ${poll.user.email}.`));
      return;
    }
    if (poll.status === 'slow_down') {
      interval += 5000;
      continue;
    }
    if (poll.status === 'denied') throw new Error('Sign-in was denied in the browser.');
    if (poll.status === 'expired') throw new Error("That code expired. Run 'agents auth login' again.");
  }
  throw new Error("Timed out waiting for approval. Run 'agents auth login' again.");
}

async function whoami(json: boolean): Promise<void> {
  const session = readSession();
  if (!session) {
    if (json) {
      console.log(JSON.stringify({ signedIn: false }, null, 2));
      return;
    }
    console.log(chalk.gray("Not signed in. Run 'agents auth login'."));
    process.exitCode = 1;
    return;
  }
  try {
    const me = await fetchWhoAmI();
    // Keep the persisted profile picture current: the actor env and share
    // attribution read it from the session file, never from the network.
    await refreshSessionAvatar(me);
    if (json) {
      console.log(JSON.stringify({ signedIn: true, ...me }, null, 2));
      return;
    }
    console.log(`${chalk.bold(me.email)}  ${chalk.gray(me.userId)}`);
  } catch (err) {
    if (err instanceof PhoenixApiError && err.status === 401) {
      throw new Error("Your session is no longer valid. Run 'agents auth login' again.");
    }
    throw err;
  }
}

function printSpaces(spaces: Awaited<ReturnType<typeof listSpaces>>): void {
  if (!spaces.length) {
    console.log(chalk.gray("  No spaces yet. Create one with 'agents auth space create <name>'."));
    return;
  }
  for (const space of spaces) {
    console.log(`  ${chalk.cyan(space.slug)}  ${space.name}  ${chalk.gray(space.user_role)}`);
  }
}

/** Resolve a space reference (or the caller's only space) to a concrete space. */
async function requireSpace(ref?: string): Promise<Awaited<ReturnType<typeof listSpaces>>[number]> {
  const spaces = await listSpaces();
  const space = resolveSpaceFromList(spaces, ref);
  if (space) return space;
  if (!ref) {
    throw new Error(
      spaces.length
        ? `You are in ${spaces.length} spaces — name one: ${spaces.map((s) => s.slug).join(', ')}.`
        : "You are not in a space yet. Create one with 'agents auth space create <name>'.",
    );
  }
  throw new Error(`No space named '${ref}'.`);
}

export function registerAuthCommand(program: Command): void {
  const auth = program
    .command('auth')
    .description('Sign in to Phoenix ID — the account layer behind team spaces');

  setHelpSections(auth, {
    examples: `agents auth login                         # device-code sign-in via your browser
agents auth whoami                        # who this machine is signed in as
agents auth space create "Design Team"    # start a space
agents auth space invite ada@example.com  # add a teammate
agents auth logout                        # clear this machine only`,
    notes: `Signing in is optional — every local feature works with no account; team spaces are what it unlocks.
Sign-in is Google-only and opens a Phoenix-branded page; the CLI never sees a password.
The session lives in this machine's agents state dir, so logging out here signs out nothing else.
Point at a different backend with PHOENIX_ID_BASE (defaults to the production service).
Harness worker credentials are minted by \`agents accounts add <harness> [name]\` / \`agents accounts login <harness>#<name>\`, not by this command.`,
  });

  auth
    .command('login')
    .description('Sign in with the device-code flow')
    .action(() => runOrDie(() => login()));

  auth
    .command('whoami')
    .description('Show the signed-in account')
    .option('--json', 'Machine-readable output')
    .action((o: { json?: boolean }, command: Command) => {
      const json = !!o.json || !!command.optsWithGlobals().json;
      return runOrDie(() => whoami(json), { json });
    });

  auth
    .command('logout')
    .description("Clear this machine's session (no other device is affected)")
    .action(() =>
      runOrDie(() => {
        const session = readSession();
        clearSession();
        console.log(session ? chalk.green(`Signed out ${session.email ?? 'this machine'}.`) : chalk.gray('Already signed out.'));
      }));

  const space = auth.command('space').description('Spaces — share work with teammates');

  space
    .command('list', { isDefault: true })
    .description('Spaces you belong to')
    .option('--json', 'Machine-readable output')
    .action((o: { json?: boolean }, command: Command) => {
      const json = !!o.json || !!command.optsWithGlobals().json;
      return runOrDie(async () => {
        const spaces = await listSpaces();
        if (json) return console.log(JSON.stringify(spaces, null, 2));
        printSpaces(spaces);
      }, { json });
    });

  space
    .command('create <name>')
    .description('Create a space')
    .option('--slug <slug>', 'URL-safe name (defaults to a slug of <name>)')
    .option('--json', 'Machine-readable output')
    .action((name: string, o: { slug?: string; json?: boolean }, command: Command) => {
      const json = !!o.json || !!command.optsWithGlobals().json;
      return runOrDie(async () => {
        const created = await createSpace({ name, slug: o.slug ?? slugify(name) });
        if (json) return console.log(JSON.stringify(created, null, 2));
        console.log(chalk.green(`Created ${created.name} (${created.slug}).`));
      }, { json });
    });

  space
    .command('members [space]')
    .description('Who is in a space')
    .option('--json', 'Machine-readable output')
    .action((ref: string | undefined, o: { json?: boolean }, command: Command) => {
      const json = !!o.json || !!command.optsWithGlobals().json;
      return runOrDie(async () => {
        const target = await requireSpace(ref);
        const members = await listSpaceMembers(target.id);
        if (json) return console.log(JSON.stringify(members, null, 2));
        for (const m of members) console.log(`  ${m.email}  ${chalk.gray(m.role)}`);
      }, { json });
    });

  space
    .command('invite <email>')
    .description('Invite someone to a space')
    .option('--space <space>', 'Which space (defaults to your only one)')
    .option('--role <role>', 'admin or member', 'member')
    .option('--json', 'Machine-readable output')
    .action((email: string, o: { space?: string; role?: string; json?: boolean }, command: Command) => {
      const json = !!o.json || !!command.optsWithGlobals().json;
      return runOrDie(async () => {
        if (o.role !== 'admin' && o.role !== 'member') {
          throw new Error(`--role must be admin or member (got '${o.role}').`);
        }
        const target = await requireSpace(o.space);
        const result = await createSpaceInvite(target.id, { email, role: o.role });
        if (json) return console.log(JSON.stringify(result, null, 2));
        console.log(
          result.member_added
            ? chalk.green(`Added ${email} to ${target.name} as ${o.role}.`)
            : chalk.green(`Invited ${email} to ${target.name} as ${o.role}. Invite code: ${result.invite_code}`),
        );
      }, { json });
    });

  space
    .command('role <email> <role>')
    .description('Change a member\'s role (owner only for admin)')
    .option('--space <space>', 'Which space (defaults to your only one)')
    .option('--json', 'Machine-readable output')
    .action((email: string, role: string, o: { space?: string; json?: boolean }, command: Command) => {
      const json = !!o.json || !!command.optsWithGlobals().json;
      return runOrDie(async () => {
        if (role !== 'admin' && role !== 'member') {
          throw new Error(`role must be admin or member (got '${role}').`);
        }
        const target = await requireSpace(o.space);
        const member = resolveMemberFromList(await listSpaceMembers(target.id), email);
        if (!member) throw new Error(`${email} is not in ${target.name}.`);
        const updated = await updateSpaceMemberRole(target.id, member.user_id, role);
        if (json) return console.log(JSON.stringify(updated, null, 2));
        console.log(chalk.green(`${email} is now ${role} in ${target.name}.`));
      }, { json });
    });

  space
    .command('remove <email>')
    .description('Remove a member (or yourself) from a space')
    .option('--space <space>', 'Which space (defaults to your only one)')
    .option('--json', 'Machine-readable output')
    .action((email: string, o: { space?: string; json?: boolean }, command: Command) => {
      const json = !!o.json || !!command.optsWithGlobals().json;
      return runOrDie(async () => {
        const target = await requireSpace(o.space);
        const member = resolveMemberFromList(await listSpaceMembers(target.id), email);
        if (!member) throw new Error(`${email} is not in ${target.name}.`);
        await removeSpaceMember(target.id, member.user_id);
        if (json) return console.log(JSON.stringify({ removed: true, email, space: target.slug }, null, 2));
        console.log(chalk.green(`Removed ${email} from ${target.name}.`));
      }, { json });
    });
}
