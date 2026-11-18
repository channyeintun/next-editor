// The background jobs of a shell: the ones each shell environment lists
// (`jobs`, `%N`, `wait`, the prompt's notices) and, of those that have ended
// and left the list, the status each ended with, which `wait pid` still
// answers; and, for the whole process, the jobs it runs in its own worker,
// which outlive the shell as forked subshells outlive bash.
import type { ExitStatus } from "../../runtime";
import { runtime } from "../../runtime";
import { signalDescription } from "./signals";

/** A background job. */
export interface Job {
  id: number;
  /** A child's pid, or for a job run in the shell's process a pid of its own. */
  pid: number | null;
  /** The job as written (`sleep 30`), as `jobs` shows it. */
  command: string;
  done: Promise<number>;
  status: number | null;
  /** The signal that ended it, once it has ended of one. */
  signal: string | null;
  /**
   * The job is a child process that leads a process group of its own (a job
   * of a shell with job control): `kill %N` signals the group, as bash does,
   * so what the program started gets the signal too.
   */
  ownGroup: boolean;
  /**
   * Ends a job that runs in the shell's process; absent for a child process
   * (use the kernel). `wholeJob`: the job was named as a job (`kill %N`), so
   * the signal is for all of it, the process groups of its programs included.
   */
  kill?: (signal: string, wholeJob: boolean) => void;
  /** Set by `disown -h`: the shell's hangup does not reach it. */
  keptFromHangup?: boolean;
}

/**
 * The jobs one shell environment lists. A subshell starts with none, as
 * bash's forked subshell does: its `wait`, `jobs` and `%N` are about the
 * jobs it starts itself, never about the job it is.
 */
export interface JobList {
  /** The jobs listed: running, or ended and not yet reported or waited for. */
  jobs: Job[];
  /**
   * By pid: the status of each job that has ended and left `jobs`, so that
   * `wait pid` still answers, as bash keeps the statuses of the children it
   * has reaped. Only the newest `REMEMBERED_JOBS` are kept.
   */
  endedJobs: Map<number, number>;
  /**
   * Of `jobs`, those of the shell this one was copied from, which it lists
   * but did not start (`inheritJobs`): `wait` cannot wait for them.
   */
  inherited: ReadonlySet<Job>;
}

/** The jobs of one shell process, whichever shell environment started them. */
export interface JobTable {
  /**
   * The jobs the shell runs in its own process (a subshell, a group, an
   * and-or list, a builtin or a function put in the background) until each
   * has ended, listed or not: `disown` takes a job off the list, and it
   * still runs here.
   */
  ownJobs: Set<Job>;
  /**
   * Set once the shell has ended while such jobs ran and handed them to the
   * new process the worker went on as (`outliveShell`): the pid and ppid the
   * shell had, which `$$` and `$PPID` still name, as in a forked subshell.
   */
  handedOver: { pid: number; ppid: number } | null;
}

/** How many ended jobs' statuses a shell keeps for `wait pid`. */
export const REMEMBERED_JOBS = 1024;

/** A process that runs no job. */
export function newJobTable(): JobTable {
  return { ownJobs: new Set(), handedOver: null };
}

/** A list with no jobs. */
export function newJobList(): JobList {
  return { jobs: [], endedJobs: new Map(), inherited: new Set() };
}

/**
 * A copy of `list` for a shell that lists the jobs of the one it comes from
 * and did not start them: a command substitution, and a lone `jobs` run as
 * a stage of a pipeline, as in bash 3.2 (`jobs | cat`, `$(jobs)`).
 */
export function inheritJobs(list: JobList): JobList {
  return {
    jobs: [...list.jobs],
    endedJobs: new Map(list.endedJobs),
    inherited: new Set(list.jobs),
  };
}

/** Lists `job`, which has just started. */
export function addJob(table: JobList, job: Job): void {
  if (job.pid !== null) {
    // The pid is this job's now, whatever an earlier job of that pid ended with.
    table.endedJobs.delete(job.pid);
  }
  table.jobs.push(job);
}

/** `job` runs in the shell's own process: it is one of `ownJobs` until it has ended. */
export function addOwnJob(table: JobTable, job: Job): void {
  table.ownJobs.add(job);
  const ended = () => table.ownJobs.delete(job);
  job.done.then(ended, ended);
}

/**
 * The shell has ended with `status`. A job it runs in its own process is a
 * forked subshell in bash, which goes on without the shell: while any still
 * runs, the shell's process ends for whoever waits for it (its parent, a
 * `spawnSync`, a `child_process` "exit") and the worker goes on as a new
 * process, which holds the shell's file descriptors (a pipe the jobs write to
 * ends when they have ended) and runs the jobs to their end. Resolves once
 * they all have, true; at once with false when none runs, and the shell ends
 * as it would.
 */
export async function outliveShell(table: JobTable, status: ExitStatus): Promise<boolean> {
  if (table.ownJobs.size === 0) {
    return false;
  }
  const rt = runtime();
  table.handedOver = { pid: rt.pid, ppid: rt.ppid };
  rt.processes.forkAndExit(status);
  // A job may start jobs of its own meanwhile.
  while (table.ownJobs.size > 0) {
    await Promise.all(Array.from(table.ownJobs, (job) => job.done));
  }
  return true;
}

/**
 * Takes `job`, which has ended, off the list: it has been reported, or
 * waited for. Its status stays known to `wait pid`.
 */
export function forgetJob(table: JobList, job: Job): void {
  const index = table.jobs.indexOf(job);
  if (index < 0) {
    return;
  }
  table.jobs.splice(index, 1);
  if (job.pid === null || job.status === null) {
    return;
  }
  const { endedJobs } = table;
  // The newest last, whatever was known of this pid before.
  endedJobs.delete(job.pid);
  endedJobs.set(job.pid, job.status);
  if (endedJobs.size > REMEMBERED_JOBS) {
    const [oldest] = endedJobs.keys();
    endedJobs.delete(oldest);
  }
}

/**
 * Takes `job` off the list (`disown`): the shell no longer reports it,
 * waits for it or hangs it up when it ends; the job runs on. With
 * `keepListed` (`disown -h`) it stays listed and is only spared the hangup.
 */
export function disownJob(table: JobList, job: Job, keepListed: boolean): void {
  if (keepListed) {
    job.keptFromHangup = true;
    return;
  }
  const index = table.jobs.indexOf(job);
  if (index >= 0) {
    table.jobs.splice(index, 1);
  }
}

/**
 * A job as bash's `jobs` and its notices show it: `[1]+  Running
 * sleep 30 &`, `[2]-  Exit 3  …`, `[3]   Terminated  …`. `+` is the newest
 * job, `-` the one before.
 */
export function jobLine(jobs: Job[], job: Job): string {
  const index = jobs.indexOf(job);
  const mark = index === jobs.length - 1 ? "+" : index === jobs.length - 2 ? "-" : " ";
  let state: string;
  if (job.status === null) {
    state = "Running";
  } else if (job.signal !== null) {
    state = signalDescription(job.signal);
  } else {
    state = job.status === 0 ? "Done" : `Exit ${job.status}`;
  }
  const command = job.status === null ? `${job.command} &` : job.command;
  // bash pads the state to 24 columns ("%*s" with 24 minus its length).
  return `[${job.id}]${mark}  ${state}${" ".repeat(Math.abs(24 - state.length))}${command}\n`;
}

/**
 * Reports every job that has ended (`jobLine`, with `write`) and takes it off
 * the list: bash's notices, which an interactive shell gives before a prompt
 * and once a foreground job has ended.
 */
export function announceEndedJobs(table: JobList, write: (text: string) => void): void {
  for (const job of table.jobs) {
    if (job.status !== null) {
      write(jobLine(table.jobs, job));
    }
  }
  forgetEndedJobs(table);
}

/** Takes every job that has ended off the list (`forgetJob`): they have been reported. */
export function forgetEndedJobs(table: JobList): void {
  for (const job of table.jobs.filter((listed) => listed.status !== null)) {
    forgetJob(table, job);
  }
}
