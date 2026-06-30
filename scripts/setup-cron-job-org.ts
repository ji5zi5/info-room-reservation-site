import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import ky, { HTTPError } from "ky";
import { z } from "zod";

import {
  CLOSED_PERIOD_CRON_TITLE,
  buildClosedPeriodCronJob,
  normalizeCronBaseUrl,
  type CronJobOrgPayload
} from "../src/lib/cron-job-org-config";

const EnvSchema = z.object({
  CRON_JOB_ORG_API_KEY: z.string().min(1),
  CRON_JOB_ORG_JOB_ID: z.coerce.number().int().positive().optional(),
  CRON_SECRET: z.string().min(1),
  EXTERNAL_CRON_BASE_URL: z.string().url()
});

const JobSummarySchema = z.object({
  jobId: z.number().int().positive(),
  title: z.string(),
  url: z.string().url()
});

const JobsResponseSchema = z.object({
  jobs: z.array(JobSummarySchema)
});

const CreateJobResponseSchema = z.object({
  jobId: z.number().int().positive()
});

type Env = z.infer<typeof EnvSchema>;
type JobSummary = z.infer<typeof JobSummarySchema>;

type CronJobOrgClient = {
  readonly createJob: (payload: CronJobOrgPayload) => Promise<number>;
  readonly listJobs: () => Promise<readonly JobSummary[]>;
  readonly updateJob: (jobId: number, payload: CronJobOrgPayload) => Promise<void>;
};

async function main(): Promise<void> {
  loadLocalEnv();
  const env = EnvSchema.parse(process.env);
  const payload = buildClosedPeriodCronJob({
    baseUrl: env.EXTERNAL_CRON_BASE_URL,
    cronSecret: env.CRON_SECRET
  });
  const client = createCronJobOrgClient(env.CRON_JOB_ORG_API_KEY);
  const existingJobId = env.CRON_JOB_ORG_JOB_ID ?? (await findMatchingJob(client, payload));

  if (existingJobId) {
    await client.updateJob(existingJobId, payload);
    console.log(`Updated cron-job.org job ${existingJobId}: ${payload.url}`);
    return;
  }

  const createdJobId = await client.createJob(payload);
  console.log(`Created cron-job.org job ${createdJobId}: ${payload.url}`);
}

function loadLocalEnv(): void {
  loadDotenvFile(resolve(process.cwd(), ".env.local"));
  loadDotenvFile(resolve(process.cwd(), ".env"));
}

function loadDotenvFile(path: string): void {
  if (!existsSync(path)) {
    return;
  }
  for (const line of readFileSync(path, "utf8").split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }
    const key = trimmed.slice(0, separatorIndex).trim();
    if (!/^[A-Z_][A-Z0-9_]*$/u.test(key) || process.env[key] !== undefined) {
      continue;
    }
    process.env[key] = parseEnvValue(trimmed.slice(separatorIndex + 1).trim());
  }
}

function parseEnvValue(value: string): string {
  const doubleQuoted = /^"(?<content>.*)"$/u.exec(value);
  if (doubleQuoted?.groups?.content !== undefined) {
    return doubleQuoted.groups.content;
  }
  const singleQuoted = /^'(?<content>.*)'$/u.exec(value);
  return singleQuoted?.groups?.content ?? value;
}

function createCronJobOrgClient(apiKey: string): CronJobOrgClient {
  const api = ky.create({
    headers: {
      Authorization: `Bearer ${apiKey}`
    },
    prefixUrl: "https://api.cron-job.org"
  });

  return {
    async createJob(payload) {
      const response = await api.put("jobs", { json: { job: payload } }).json();
      return CreateJobResponseSchema.parse(response).jobId;
    },
    async listJobs() {
      const response = await api.get("jobs").json();
      return JobsResponseSchema.parse(response).jobs;
    },
    async updateJob(jobId, payload) {
      await api.patch(`jobs/${jobId}`, { json: { job: payload } });
    }
  };
}

async function findMatchingJob(client: CronJobOrgClient, payload: CronJobOrgPayload): Promise<number | undefined> {
  const jobs = await client.listJobs();
  const normalizedTargetBaseUrl = normalizeCronBaseUrl(payload.url);
  return jobs.find(
    (job) => job.title === CLOSED_PERIOD_CRON_TITLE && normalizeCronBaseUrl(job.url) === normalizedTargetBaseUrl
  )?.jobId;
}

async function runCli(): Promise<void> {
  try {
    await main();
  } catch (error) {
    if (error instanceof z.ZodError) {
      console.error("Missing or invalid env for cron-job.org setup:");
      for (const issue of error.issues) {
        console.error(`- ${issue.path.join(".")}: ${issue.message}`);
      }
      process.exitCode = 1;
      return;
    }
    if (error instanceof HTTPError) {
      console.error(`cron-job.org API failed with HTTP ${error.response.status}`);
      console.error(await error.response.text());
      process.exitCode = 1;
      return;
    }
    throw error;
  }
}

void runCli();
