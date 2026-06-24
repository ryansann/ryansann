#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const writeReadme = args.includes("--write-readme");
const login = args.find((arg) => !arg.startsWith("--")) || "ryansann";
const startYearArg = args.find((arg, index) => index > 0 && !arg.startsWith("--") && /^\d{4}$/.test(arg));
const startYear = Number(startYearArg || 2011);
const now = new Date();
const currentYear = now.getUTCFullYear();

const graphql = async (query, variables) => {
  const token = process.env.METRICS_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (token) {
    const response = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
    });

    if (!response.ok) {
      throw new Error(`GitHub GraphQL failed: ${response.status} ${response.statusText}`);
    }

    const payload = await response.json();
    if (payload.errors?.length) {
      throw new Error(JSON.stringify(payload.errors, null, 2));
    }
    return payload;
  }

  const ghArgs = ["api", "graphql", "-f", `query=${query}`];
  for (const [key, value] of Object.entries(variables)) {
    ghArgs.push("-f", `${key}=${value}`);
  }
  const output = execFileSync("gh", ghArgs, { encoding: "utf8" });
  return JSON.parse(output);
};

const query = `
  query($login: String!, $from: DateTime!, $to: DateTime!) {
    user(login: $login) {
      createdAt
      contributionsCollection(from: $from, to: $to) {
        totalCommitContributions
        totalIssueContributions
        totalPullRequestContributions
        totalPullRequestReviewContributions
        totalRepositoryContributions
        contributionCalendar {
          totalContributions
          weeks {
            contributionDays {
              date
              contributionCount
            }
          }
        }
      }
    }
  }
`;

const ranges = [];
for (let year = startYear; year <= currentYear; year += 1) {
  const from = `${year}-01-01T00:00:00Z`;
  const to = year === currentYear
    ? now.toISOString()
    : `${year}-12-31T23:59:59Z`;
  ranges.push({ year, from, to });
}

const yearly = [];
for (const { year, from, to } of ranges) {
  const response = await graphql(query, { login, from, to });
  const collection = response.data.user.contributionsCollection;
  const days = collection.contributionCalendar.weeks
    .flatMap((week) => week.contributionDays)
    .filter((day) => day.date.startsWith(String(year)));

  const activeDays = days.filter((day) => day.contributionCount > 0).length;
  const maxDay = days.reduce(
    (best, day) => day.contributionCount > best.contributionCount ? day : best,
    { date: "", contributionCount: 0 },
  );

  yearly.push({
    year,
    days,
    total: collection.contributionCalendar.totalContributions,
    commits: collection.totalCommitContributions,
    prs: collection.totalPullRequestContributions,
    reviews: collection.totalPullRequestReviewContributions,
    issues: collection.totalIssueContributions,
    repos: collection.totalRepositoryContributions,
    activeDays,
    maxDay,
  });
}

const allDays = yearly.flatMap((year) => year.days)
  .filter((day) => new Date(`${day.date}T00:00:00Z`) <= now)
  .sort((a, b) => a.date.localeCompare(b.date));

const daysSince = (days) => {
  const cutoff = new Date(now);
  cutoff.setUTCDate(cutoff.getUTCDate() - days + 1);
  return allDays.filter((day) => new Date(`${day.date}T00:00:00Z`) >= cutoff);
};

const sumDays = (days) => days.reduce((total, day) => total + day.contributionCount, 0);
const activeDays = (days) => days.filter((day) => day.contributionCount > 0).length;

const longestStreak = (days) => {
  let best = 0;
  let current = 0;
  for (const day of days) {
    if (day.contributionCount > 0) {
      current += 1;
      best = Math.max(best, current);
    } else {
      current = 0;
    }
  }
  return best;
};

const currentStreak = (days) => {
  let streak = 0;
  for (let index = days.length - 1; index >= 0; index -= 1) {
    if (days[index].contributionCount === 0) {
      if (streak === 0 && days[index].date === now.toISOString().slice(0, 10)) {
        continue;
      }
      break;
    }
    streak += 1;
  }
  return streak;
};

const totals = yearly.reduce((acc, year) => ({
  total: acc.total + year.total,
  commits: acc.commits + year.commits,
  prs: acc.prs + year.prs,
  reviews: acc.reviews + year.reviews,
  issues: acc.issues + year.issues,
  repos: acc.repos + year.repos,
  activeDays: acc.activeDays + year.activeDays,
}), {
  total: 0,
  commits: 0,
  prs: 0,
  reviews: 0,
  issues: 0,
  repos: 0,
  activeDays: 0,
});

const rankedYears = [...yearly].sort((a, b) => b.total - a.total);
const current = yearly.at(-1);
const last30 = daysSince(30);
const last90 = daysSince(90);
const last365 = daysSince(365);
const last3Years = yearly.filter((year) => year.year >= currentYear - 2);
const last3YearTotal = last3Years.reduce((total, year) => total + year.total, 0);
const roundDown = (value, nearest = 100) => Math.floor(value / nearest) * nearest;
const generatedBlock = [
  "<!-- PROFILE_STATS:start -->",
  `- ${roundDown(totals.total).toLocaleString()}+ GitHub contributions`,
  `- ${roundDown(totals.activeDays).toLocaleString()}+ active contribution days`,
  "<!-- PROFILE_STATS:end -->",
].join("\n");

if (writeReadme) {
  const readmePath = "README.md";
  const readme = readFileSync(readmePath, "utf8");
  const start = "<!-- PROFILE_STATS:start -->";
  const end = "<!-- PROFILE_STATS:end -->";
  const nextReadme = readme.includes(start) && readme.includes(end)
    ? readme.replace(new RegExp(`${start}[\\s\\S]*?${end}`), generatedBlock)
    : readme.replace(
      /### 📈 GitHub activity\n\n(?:- .+\n?)+/,
      `### 📈 GitHub activity\n\n${generatedBlock}\n`,
    );

  if (nextReadme !== readme) {
    writeFileSync(readmePath, nextReadme);
  }
}

console.log(`# GitHub profile stats for @${login}`);
console.log("");
console.log("These are aggregate contribution counts from GitHub GraphQL for the authenticated viewer.");
console.log("");
console.log("## Strongest headline candidates");
console.log("");
console.log(`- ${totals.total.toLocaleString()} total GitHub contributions since ${startYear}`);
console.log(`- ${totals.activeDays.toLocaleString()} active contribution days`);
console.log(`- ${last3YearTotal.toLocaleString()} contributions since ${currentYear - 2}`);
console.log(`- Best year: ${rankedYears[0].year} with ${rankedYears[0].total.toLocaleString()} contributions`);
console.log(`- ${current.year} so far: ${current.total.toLocaleString()} contributions across ${current.activeDays.toLocaleString()} active days`);
console.log(`- Last 365 days: ${sumDays(last365).toLocaleString()} contributions across ${activeDays(last365).toLocaleString()} active days`);
console.log(`- Last 90 days: ${sumDays(last90).toLocaleString()} contributions across ${activeDays(last90).toLocaleString()} active days`);
console.log(`- Longest daily activity streak: ${longestStreak(allDays).toLocaleString()} days`);
console.log(`- Current daily activity streak: ${currentStreak(allDays).toLocaleString()} days`);
console.log("");
console.log("## Lower-confidence breakdown");
console.log("");
console.log("These per-type totals can undercount private work depending on token scopes and GitHub visibility rules.");
console.log("");
console.log(`- ${totals.commits.toLocaleString()} visible commits`);
console.log(`- ${totals.prs.toLocaleString()} visible pull requests`);
console.log(`- ${totals.reviews.toLocaleString()} visible reviews`);
console.log("");
console.log("## Yearly breakdown");
console.log("");
console.log("| Year | Total | Commits | PRs | Reviews | Issues | Repos | Active days | Best day |");
console.log("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |");
for (const year of yearly) {
  console.log(`| ${year.year} | ${year.total.toLocaleString()} | ${year.commits.toLocaleString()} | ${year.prs.toLocaleString()} | ${year.reviews.toLocaleString()} | ${year.issues.toLocaleString()} | ${year.repos.toLocaleString()} | ${year.activeDays.toLocaleString()} | ${year.maxDay.date || "-"} (${year.maxDay.contributionCount}) |`);
}
