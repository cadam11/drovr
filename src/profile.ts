import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { iconForm } from '../lambda/hey/handler.ts';
import type { Program } from './control.ts';
import { defaultCaller, setProfile } from './hey.ts';
import { listRepos, worktreeRepoId } from './orca.ts';
import { ensureDirs, paths } from './paths.ts';

/**
 * Lucide names Orca offers → the SF Symbol the phone draws. Unlisted means no icon and the
 * monogram stays; a wrong glyph is worse than none. Extend by hand when a repo uses a new one.
 */
export const LUCIDE_TO_SF: Record<string, string> = {
  Globe: 'globe',
  Rocket: 'paperplane.fill',
  Bot: 'cpu',
  Database: 'cylinder.split.1x2',
  Server: 'server.rack',
  Terminal: 'terminal',
  Code: 'chevron.left.forwardslash.chevron.right',
  Book: 'book',
  Bug: 'ant',
  Cloud: 'cloud',
  Folder: 'folder',
  Heart: 'heart',
  Home: 'house',
  Mail: 'envelope',
  Megaphone: 'megaphone',
  Shield: 'shield',
  Star: 'star',
  Zap: 'bolt',
};

/** The three icon shapes `orca repo list --json` emits (read 2026-10-16); passthrough keeps `source`/`label`. */
const repoIconShape = z.discriminatedUnion('type', [
  z.object({ type: z.literal('emoji'), emoji: z.string() }).passthrough(),
  z.object({ type: z.literal('lucide'), name: z.string() }).passthrough(),
  z.object({ type: z.literal('image'), src: z.string() }).passthrough(),
]);
type RepoIcon = z.infer<typeof repoIconShape>;

/** Lenient on purpose, like preview.ts: an unrecognised repo yields nothing, never a failed seed. */
const repoShape = z.object({
  id: z.string(),
  badgeColor: z.string().nullable().optional(),
  repoIcon: z.unknown().optional(),
});

export type ProfilePatch = { icon?: string; summary?: string; color?: string };

const iconFromRepo = (raw: unknown): string | null => {
  const parsed = repoIconShape.safeParse(raw);
  if (!parsed.success) return null;
  const icon: RepoIcon = parsed.data;
  if (icon.type === 'emoji') return iconForm(icon.emoji) === 'emoji' ? icon.emoji : null;
  if (icon.type === 'lucide') {
    const sf = LUCIDE_TO_SF[icon.name];
    return sf === undefined ? null : `sf:${sf}`;
  }
  // An https URL or a data URL within the Lambda's 32 KB; anything else the Lambda would refuse.
  return iconForm(icon.src) === null ? null : icon.src;
};

export const profileFromRepo = (repo: unknown, description: string | null): ProfilePatch | null => {
  const parsed = repoShape.safeParse(repo);
  if (!parsed.success) return null;
  const patch: ProfilePatch = {};
  const icon = iconFromRepo(parsed.data.repoIcon ?? null);
  if (icon !== null) patch.icon = icon;
  const color = parsed.data.badgeColor ?? null;
  if (color !== null && /^#[0-9a-fA-F]{6}$/.test(color)) patch.color = color;
  if (description !== null) patch.summary = description;
  return Object.keys(patch).length === 0 ? null : patch;
};

const MAX_REPOS = 500;

export const findRepo = (repos: unknown[], repoId: string): unknown | null => {
  const idShape = z.object({ id: z.string() });
  for (const repo of repos.slice(0, MAX_REPOS)) {
    const parsed = idShape.safeParse(repo);
    if (parsed.success && parsed.data.id === repoId) return repo;
  }
  return null;
};

const seededPath = (program: string): string => join(paths().programState(program), 'profile-seeded.json');

/**
 * Once per program, after its terminal is up and never before: an avatar is not worth a late
 * launch. Two orca calls and one hey call, each bounded by its own helper. Every failure is a log
 * line and a retry at the next cycle start; a success — including "nothing to seed" — writes the
 * marker, and `hey profile` is how the profile changes from then on.
 */
export const seedSenderProfile = async (program: Program, notifyTo: string | null): Promise<void> => {
  if (notifyTo === null || existsSync(seededPath(program.name))) return;
  const marker = seededPath(program.name);
  try {
    const repo = findRepo(await listRepos(), await worktreeRepoId(program));
    const patch = profileFromRepo(repo, program.description);
    if (patch === null) {
      console.log(`${program.name}: nothing to seed into its hey profile (no Orca icon or colour, no description). To try again: rm ${marker}`);
    } else {
      await setProfile(defaultCaller(), { to: notifyTo, from: program.name, ...patch });
      console.log(`${program.name}: seeded its hey profile (${Object.keys(patch).join(', ')}). Change it with: hey profile --from ${program.name} …; to seed again: rm ${marker}`);
    }
    ensureDirs(program.name);
    writeFileSync(marker, `${JSON.stringify({ seededAt: new Date().toISOString(), patch })}\n`, 'utf8');
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`${program.name}: could not seed its hey profile (${detail}) — tried again at its next cycle start`);
  }
};
