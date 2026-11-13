/**
 * B-61 provider-requester tests — the goldens are ported verbatim from
 * upstream's own batteries at the pin (services/webhook/{slack,discord,
 * dingtalk,telegram,msteams,matrix}_test.go; wechatwork/packagist/feishu
 * derive from their .go sources) over the same fixture payloads
 * (general_test.go's createTestPayload &c.). Each test serializes the fixture
 * exactly as the emitter does (2-space JSON), runs `planProviderRequest`, and
 * pins the rebuilt body + transport against upstream's expected bytes.
 */

import { describe, expect, it } from "vitest";

import {
  type ProviderPlanInput,
  hasProviderRequester,
  planProviderRequest,
} from "./requesters";

// ---------------------------------------------------------------------------
// Fixtures — general_test.go at the pin, in the payloads' JSON wire names
// ---------------------------------------------------------------------------

const SENDER = { login: "user1", avatar_url: "http://localhost:3000/user1/avatar", html_url: "http://localhost:3000/user1" };
const SENDER_PLAIN = { login: "user1", avatar_url: "http://localhost:3000/user1/avatar" };
const REPO = { html_url: "http://localhost:3000/test/repo", name: "repo", full_name: "test/repo" };
const REPO2 = { html_url: "http://localhost:3000/test/repo2", name: "repo2", full_name: "test/repo2" };
const MILESTONE = { id: 1, title: "Milestone Title", description: "Milestone Description" };
const COMMIT = {
  id: "2020558fe2e34debb818a514715839cabd25e778",
  message: "commit message",
  url: "http://localhost:3000/test/repo/commit/2020558fe2e34debb818a514715839cabd25e778",
  author: { name: "user1", email: "user1@localhost", username: "user1" },
};

const createPayload = {
  sha: "2020558fe2e34debb818a514715839cabd25e777",
  ref: "refs/heads/test",
  ref_type: "branch",
  repository: REPO,
  sender: SENDER_PLAIN,
};
const deletePayload = { ref: "refs/heads/test", ref_type: "branch", repository: REPO, sender: SENDER_PLAIN };
const forkPayload = { forkee: REPO2, repository: REPO, sender: SENDER_PLAIN };
const pushPayload = {
  ref: "refs/heads/test",
  before: "2020558fe2e34debb818a514715839cabd25e777",
  after: "2020558fe2e34debb818a514715839cabd25e778",
  compare_url: "",
  commits: [COMMIT, COMMIT],
  total_commits: 2,
  head_commit: COMMIT,
  repository: REPO,
  pusher: SENDER,
  sender: SENDER,
};
const issuePayload = (action: string) => ({
  action,
  number: 2,
  issue: {
    id: 2,
    number: 2,
    url: "http://localhost:3000/api/v1/repos/test/repo/issues/2",
    html_url: "http://localhost:3000/test/repo/issues/2",
    title: "crash",
    body: "issue body",
    user: SENDER_PLAIN,
    assignees: [SENDER_PLAIN],
    milestone: MILESTONE,
  },
  repository: REPO,
  sender: SENDER,
});
const issueCommentPayload = {
  action: "created",
  issue: {
    id: 2,
    number: 2,
    url: "http://localhost:3000/api/v1/repos/test/repo/issues/2",
    html_url: "http://localhost:3000/test/repo/issues/2",
    title: "crash",
    body: "this happened",
    user: SENDER_PLAIN,
  },
  comment: {
    html_url: "http://localhost:3000/test/repo/issues/2#issuecomment-4",
    issue_url: "http://localhost:3000/test/repo/issues/2",
    body: "more info needed",
  },
  repository: REPO,
  sender: SENDER,
  is_pull: false,
};
const pullRequestCommentPayload = {
  action: "created",
  issue: {
    id: 12,
    number: 12,
    url: "http://localhost:3000/api/v1/repos/test/repo/pulls/12",
    html_url: "http://localhost:3000/test/repo/pulls/12",
    title: "Fix bug",
    body: "fixes bug #2",
    user: SENDER_PLAIN,
  },
  comment: {
    html_url: "http://localhost:3000/test/repo/pulls/12#issuecomment-4",
    pull_request_url: "http://localhost:3000/test/repo/pulls/12",
    body: "changes requested",
  },
  repository: REPO,
  sender: SENDER_PLAIN,
  is_pull: true,
};
const wikiPayload = (action: string) => ({
  action,
  repository: REPO,
  sender: SENDER_PLAIN,
  page: "index",
  comment: "Wiki change comment",
});
const releasePayload = {
  action: "published",
  release: {
    tag_name: "v1.0",
    name: "First stable release",
    body: "Note of first stable release",
    html_url: "http://localhost:3000/test/repo/releases/tag/v1.0",
    url: "",
  },
  repository: REPO,
  sender: SENDER_PLAIN,
};
const pullRequestPayload = (action: string) => ({
  action,
  number: 12,
  pull_request: {
    id: 12,
    number: 12,
    url: "http://localhost:3000/test/repo/pulls/12",
    html_url: "http://localhost:3000/test/repo/pulls/12",
    title: "Fix bug",
    body: "fixes bug #2",
    merged: false,
    user: SENDER_PLAIN,
    assignees: [SENDER_PLAIN],
    milestone: MILESTONE,
  },
  review: { content: "good job" },
  repository: REPO,
  sender: SENDER,
});
const repositoryPayload = (action: string) => ({
  action,
  repository: REPO,
  sender: SENDER_PLAIN,
});
const packagePayload = {
  action: "created",
  package: {
    html_url: "http://localhost:3000/user1/-/packages/container/GiteaContainer/latest",
    name: "GiteaContainer",
    version: "latest",
    type: "container",
  },
  organization: { name: "org1", avatar_url: "http://localhost:3000/org1/avatar" },
  sender: SENDER_PLAIN,
};

/** The stored payload bytes (emitWebhookDeliveries' 2-space shape). */
const stored = (payload: unknown): string => JSON.stringify(payload, null, 2);

function plan(hook: Partial<ProviderPlanInput["hook"]>, event: string, payload: unknown, appUrl = "https://try.gitea.io") {
  const input: ProviderPlanInput = {
    hook: { type: "gitea", url: "https://provider.example/hook", httpMethod: "POST", secret: "", meta: "{}", ...hook },
    event,
    payloadText: stored(payload),
    appUrl,
  };
  return planProviderRequest(input);
}

async function body(hook: Partial<ProviderPlanInput["hook"]>, event: string, payload: unknown): Promise<Record<string, unknown>> {
  const result = await plan(hook, event, payload);
  if (result.kind !== "provider") throw new Error(`expected a provider plan, got ${result.kind}`);
  return JSON.parse(result.body) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// The registry (webhook.go webhookRequesters + IsValidHookTaskType)
// ---------------------------------------------------------------------------

describe("hasProviderRequester (the webhookRequesters registry)", () => {
  it("registers the nine provider requesters; gitea/gogs answer through the default arm", () => {
    for (const type of ["slack", "discord", "dingtalk", "telegram", "msteams", "feishu", "matrix", "wechatwork", "packagist"]) {
      expect(hasProviderRequester(type)).toBe(true);
    }
    expect(hasProviderRequester("gitea")).toBe(false);
    expect(hasProviderRequester("gogs")).toBe(false);
    expect(hasProviderRequester("irc")).toBe(false);
  });

  it("routes gitea/gogs/unknown types to the default request (Deliver's nil-requester arm)", async () => {
    for (const type of ["gitea", "gogs", "irc"]) {
      const result = await plan({ type }, "push", pushPayload);
      expect(result).toEqual({ kind: "default" });
    }
  });
});

// ---------------------------------------------------------------------------
// slack.go — TestSlackPayload goldens
// ---------------------------------------------------------------------------

describe("slack requesters (slack_test.go goldens)", () => {
  it("Create", async () => {
    const bodyJson = await body({ type: "slack" }, "create", createPayload);
    expect(bodyJson.text).toBe("[<http://localhost:3000/test/repo|test/repo>:<http://localhost:3000/test/repo/src/branch/test|test>] branch created by user1");
  });

  it("Delete", async () => {
    const bodyJson = await body({ type: "slack" }, "delete", deletePayload);
    expect(bodyJson.text).toBe("[<http://localhost:3000/test/repo|test/repo>:test] branch deleted by user1");
  });

  it("Fork", async () => {
    const bodyJson = await body({ type: "slack" }, "fork", forkPayload);
    expect(bodyJson.text).toBe("<http://localhost:3000/test/repo2|test/repo2> is forked to <http://localhost:3000/test/repo|test/repo>");
  });

  it("Push", async () => {
    const bodyJson = await body({ type: "slack" }, "push", pushPayload);
    expect(bodyJson.text).toBe("[<http://localhost:3000/test/repo|test/repo>:<http://localhost:3000/test/repo/src/branch/test|test>] 2 new commits pushed by user1");
    const attachments = bodyJson.attachments as Array<Record<string, unknown>>;
    expect(attachments).toHaveLength(1);
    expect(attachments[0]!.author_name).toBe("user1");
    expect(attachments[0]!.author_icon).toBe("http://localhost:3000/user1/avatar");
    expect(attachments[0]!.author_link).toBe("http://localhost:3000/user1");
  });

  it("Issue (opened + closed)", async () => {
    const opened = await body({ type: "slack" }, "issues", issuePayload("opened"));
    expect(opened.text).toBe("[<http://localhost:3000/test/repo|test/repo>] Issue opened: <http://localhost:3000/test/repo/issues/2|#2 crash> by <https://try.gitea.io/user1|user1>");
    const attachments = opened.attachments as Array<Record<string, unknown>>;
    expect(attachments).toHaveLength(1);
    expect(attachments[0]!.author_name).toBe("user1");
    expect(attachments[0]!.color).toBe("eb6420"); // orangeColor, %x

    const closed = await body({ type: "slack" }, "issues", issuePayload("closed"));
    expect(closed.text).toBe("[<http://localhost:3000/test/repo|test/repo>] Issue closed: <http://localhost:3000/test/repo/issues/2|#2 crash> by <https://try.gitea.io/user1|user1>");
  });

  it("IssueComment + PullRequestComment (TestSlackPayload IssueComment/PullRequestComment)", async () => {
    const issueSide = await body({ type: "slack" }, "issue_comment", issueCommentPayload);
    expect(issueSide.text).toBe("[<http://localhost:3000/test/repo|test/repo>] New comment on issue <http://localhost:3000/test/repo/issues/2|#2 crash> by <https://try.gitea.io/user1|user1>");

    const prSide = await body({ type: "slack" }, "pull_request_comment", pullRequestCommentPayload);
    expect(prSide.text).toBe("[<http://localhost:3000/test/repo|test/repo>] New comment on pull request <http://localhost:3000/test/repo/pulls/12|#12 Fix bug> by <https://try.gitea.io/user1|user1>");
  });

  it("PullRequest opened", async () => {
    const bodyJson = await body({ type: "slack" }, "pull_request", pullRequestPayload("opened"));
    expect(bodyJson.text).toBe("[<http://localhost:3000/test/repo|test/repo>] Pull request opened: <http://localhost:3000/test/repo/pulls/12|#12 Fix bug> by <https://try.gitea.io/user1|user1>");
    const attachments = bodyJson.attachments as Array<Record<string, unknown>>;
    expect(attachments).toHaveLength(1);
    expect(attachments[0]!.text).toBe("fixes bug #2"); // the PR BODY re-read quirk (slack.go:257)
  });

  it("Review approved", async () => {
    const result = await plan({ type: "slack" }, "pull_request_review_approved", pullRequestPayload("reviewed"));
    if (result.kind !== "provider") throw new Error("expected provider plan");
    expect((JSON.parse(result.body) as Record<string, unknown>).text).toBe(
      "[<http://localhost:3000/test/repo|test/repo>] Pull request review approved: [#12 Fix bug](http://localhost:3000/test/repo/pulls/12) by <https://try.gitea.io/user1|user1>",
    );
  });

  it("Repository created + renamed", async () => {
    const created = await body({ type: "slack" }, "repository", repositoryPayload("created"));
    expect(created.text).toBe("[<http://localhost:3000/test/repo|test/repo>] Repository created by <https://try.gitea.io/user1|user1>");

    const renamed = await body(
      { type: "slack" },
      "repository",
      { ...repositoryPayload("renamed"), changes: { name: { from: "old-repo" } } },
    );
    expect(renamed.text).toBe("[<http://localhost:3000/test/repo|test/repo>] Repository renamed from old-repo by <https://try.gitea.io/user1|user1>");
  });

  it("Package", async () => {
    const bodyJson = await body({ type: "slack" }, "package", packagePayload);
    expect(bodyJson.text).toBe("Package created: <http://localhost:3000/user1/-/packages/container/GiteaContainer/latest|GiteaContainer:latest> by <https://try.gitea.io/user1|user1>");
  });

  it("Wiki (created/edited/deleted)", async () => {
    const created = await body({ type: "slack" }, "wiki", wikiPayload("created"));
    expect(created.text).toBe("[<http://localhost:3000/test/repo|test/repo>] New wiki page '<http://localhost:3000/test/repo/wiki/index|index>' (Wiki change comment) by <https://try.gitea.io/user1|user1>");
    const edited = await body({ type: "slack" }, "wiki", wikiPayload("edited"));
    expect(edited.text).toBe("[<http://localhost:3000/test/repo|test/repo>] Wiki page '<http://localhost:3000/test/repo/wiki/index|index>' edited (Wiki change comment) by <https://try.gitea.io/user1|user1>");
    const deleted = await body({ type: "slack" }, "wiki", wikiPayload("deleted"));
    expect(deleted.text).toBe("[<http://localhost:3000/test/repo|test/repo>] Wiki page '<http://localhost:3000/test/repo/wiki/index|index>' deleted by <https://try.gitea.io/user1|user1>");
  });

  it("Release", async () => {
    const bodyJson = await body({ type: "slack" }, "release", releasePayload);
    expect(bodyJson.text).toBe("[<http://localhost:3000/test/repo|test/repo>] Release created: <http://localhost:3000/test/repo/releases/tag/v1.0|v1.0> by <https://try.gitea.io/user1|user1>");
  });

  it("carries the meta block and always-serialized fields (TestSlackJSONPayload byte shape)", async () => {
    const result = await plan(
      { type: "slack", meta: JSON.stringify({ channel: "general", username: "gitea-bot", color: "blue" }) },
      "create",
      createPayload,
    );
    if (result.kind !== "provider") throw new Error("expected provider plan");
    expect(result.method).toBe("POST");
    expect(result.url).toBe("https://provider.example/hook");
    expect(result.contentType).toBe("application/json");
    expect(result.defaultHeaders).toBe(true);
    // Go struct field order + nil attachments → null; no HTML escapes needed here.
    expect(result.body).toBe(
      `{
  "channel": "general",
  "text": "[\\u003chttp://localhost:3000/test/repo|test/repo\\u003e:\\u003chttp://localhost:3000/test/repo/src/branch/test|test\\u003e] branch created by user1",
  "username": "gitea-bot",
  "icon_url": "",
  "unfurl_links": 0,
  "link_names": 0,
  "attachments": null
}`,
    );
  });

  it("parses an empty OBJECT meta; an empty meta string fails like Go's Unmarshal (slack.go:330-333)", async () => {
    await expect(body({ type: "slack", meta: "{}" }, "push", pushPayload)).resolves.toBeTruthy();
    await expect(plan({ type: "slack", meta: "" }, "push", pushPayload)).rejects.toThrow(
      "newSlackRequest meta json: unexpected end of JSON input",
    );
  });
});

// ---------------------------------------------------------------------------
// discord.go — TestDiscordPayload goldens
// ---------------------------------------------------------------------------

describe("discord requesters (discord_test.go goldens)", () => {
  it("Create", async () => {
    const bodyJson = await body({ type: "discord" }, "create", createPayload);
    const embeds = bodyJson.embeds as Array<Record<string, unknown>>;
    expect(embeds[0]!.title).toBe("[test/repo] branch test created");
    expect(embeds[0]!.url).toBe("http://localhost:3000/test/repo/src/test");
    expect(embeds[0]!.color).toBe(0x1ac600);
    expect(bodyJson.wait).toBe(false);
    expect(bodyJson.tts).toBe(false);
  });

  it("Push", async () => {
    const bodyJson = await body({ type: "discord" }, "push", pushPayload);
    const embeds = bodyJson.embeds as Array<Record<string, unknown>>;
    expect(embeds[0]!.title).toBe("[test/repo:test] 2 new commits");
    expect(embeds[0]!.description).toBe(
      "[2020558](http://localhost:3000/test/repo/commit/2020558fe2e34debb818a514715839cabd25e778) commit message - user1\n[2020558](http://localhost:3000/test/repo/commit/2020558fe2e34debb818a514715839cabd25e778) commit message - user1",
    );
    const author = embeds[0]!.author as Record<string, unknown>;
    expect(author.name).toBe("user1");
    expect(author.url).toBe("https://try.gitea.io/user1");
    expect(author.icon_url).toBe("http://localhost:3000/user1/avatar");
    expect(embeds[0]!.fields).toBeNull();
    expect(embeds[0]!.footer).toEqual({ text: "" });
  });

  it("Issue opened (none-link formatter, no sender suffix)", async () => {
    const bodyJson = await body({ type: "discord" }, "issues", issuePayload("opened"));
    const embeds = bodyJson.embeds as Array<Record<string, unknown>>;
    expect(embeds[0]!.title).toBe("[test/repo] Issue opened: #2 crash");
    expect(embeds[0]!.description).toBe("issue body");
    expect(embeds[0]!.url).toBe("http://localhost:3000/test/repo/issues/2");
    expect(embeds[0]!.color).toBe(0xeb6420);
  });

  it("Review approved pins the event-colored arm", async () => {
    const bodyJson = await body({ type: "discord" }, "pull_request_review_approved", pullRequestPayload("reviewed"));
    const embeds = bodyJson.embeds as Array<Record<string, unknown>>;
    expect(embeds[0]!.title).toBe("[test/repo] Pull request review approved: #12 Fix bug");
    expect(embeds[0]!.description).toBe("good job");
    expect(embeds[0]!.color).toBe(0x1ac600);
  });

  it("meta {} parses; empty meta fails (newDiscordRequest)", async () => {
    await expect(body({ type: "discord", meta: "{}" }, "push", pushPayload)).resolves.toBeTruthy();
    await expect(plan({ type: "discord", meta: "" }, "push", pushPayload)).rejects.toThrow(
      "newDiscordRequest meta json: unexpected end of JSON input",
    );
  });
});

// ---------------------------------------------------------------------------
// dingtalk.go — TestDingTalkPayload goldens
// ---------------------------------------------------------------------------

describe("dingtalk requesters (dingtalk_test.go goldens)", () => {
  function actionCard(bodyJson: Record<string, unknown>): Record<string, unknown> {
    return bodyJson.actionCard as Record<string, unknown>;
  }

  it("Create", async () => {
    const bodyJson = await body({ type: "dingtalk" }, "create", createPayload);
    expect(actionCard(bodyJson).text).toBe("[test/repo] branch test created");
    expect(actionCard(bodyJson).title).toBe("[test/repo] branch test created");
    expect(actionCard(bodyJson).singleTitle).toBe("view ref test");
    expect(actionCard(bodyJson).singleURL).toContain(
      `dingtalk://dingtalkclient/page/link?pc_slide=false&url=${encodeURIComponent("http://localhost:3000/test/repo/src/test")}`,
    );
    expect(bodyJson.msgtype).toBe("actionCard");
  });

  it("Push (\\r\\n separators, view commits)", async () => {
    const bodyJson = await body({ type: "dingtalk" }, "push", pushPayload);
    expect(actionCard(bodyJson).text).toBe(
      "[2020558](http://localhost:3000/test/repo/commit/2020558fe2e34debb818a514715839cabd25e778) commit message - user1\r\n[2020558](http://localhost:3000/test/repo/commit/2020558fe2e34debb818a514715839cabd25e778) commit message - user1",
    );
    expect(actionCard(bodyJson).title).toBe("[test/repo:test] 2 new commits");
    expect(actionCard(bodyJson).singleTitle).toBe("view commits");
    expect(actionCard(bodyJson).singleURL).toContain(`url=${encodeURIComponent("http://localhost:3000/test/repo/src/test")}`);
  });

  it("Issue opened", async () => {
    const bodyJson = await body({ type: "dingtalk" }, "issues", issuePayload("opened"));
    expect(actionCard(bodyJson).text).toBe("[test/repo] Issue opened: #2 crash by user1\r\n\r\nissue body");
    expect(actionCard(bodyJson).title).toBe("#2 crash");
    expect(actionCard(bodyJson).singleTitle).toBe("view issue");
  });

  it("IssueComment", async () => {
    const bodyJson = await body({ type: "dingtalk" }, "issue_comment", issueCommentPayload);
    expect(actionCard(bodyJson).text).toBe("[test/repo] New comment on issue #2 crash by user1\r\n\r\nmore info needed");
    expect(actionCard(bodyJson).singleURL).toContain(`url=${encodeURIComponent("http://localhost:3000/test/repo/issues/2#issuecomment-4")}`);
  });

  it("repository deleted rides the text msgtype (dingtalk.go:145-154)", async () => {
    const bodyJson = await body({ type: "dingtalk" }, "repository", repositoryPayload("deleted"));
    expect(bodyJson.msgtype).toBe("text");
    expect((bodyJson.text as Record<string, unknown>).content).toBe("[test/repo] Repository deleted");
  });

  it("serializes the full lunny Payload struct (every block, in order)", async () => {
    const result = await plan({ type: "dingtalk" }, "create", createPayload);
    if (result.kind !== "provider") throw new Error("expected provider plan");
    const parsed = JSON.parse(result.body) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(["msgtype", "text", "link", "markdown", "actionCard", "feedCard", "at"]);
    expect(parsed.link).toEqual({ text: "", title: "", picUrl: "", messageUrl: "" });
    expect(parsed.at).toEqual({ atMobiles: null, isAtAll: false });
    expect((parsed.actionCard as Record<string, unknown>).hideAvatar).toBe("0");
    expect((parsed.actionCard as Record<string, unknown>).btns).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// telegram.go — TestTelegramPayload goldens
// ---------------------------------------------------------------------------

describe("telegram requesters (telegram_test.go goldens)", () => {
  async function html(hook: Partial<ProviderPlanInput["hook"]>, event: string, payload: unknown): Promise<string> {
    const bodyJson = await body(hook, event, payload);
    return ((bodyJson.rich_message as Record<string, unknown>).html ?? "") as string;
  }

  it("rewrites /sendMessage to /sendRichMessage (newTelegramRequest, telegram.go:214-224)", async () => {
    const result = await plan({ type: "telegram", url: "https://telegram.example.com/sendMessage" }, "push", pushPayload);
    if (result.kind !== "provider") throw new Error("expected provider plan");
    expect(result.url).toBe("https://telegram.example.com/sendRichMessage");
    // A URL without the suffix is untouched.
    const plain = await plan({ type: "telegram", url: "https://telegram.example.com/hook" }, "push", pushPayload);
    if (plain.kind !== "provider") throw new Error("expected provider plan");
    expect(plain.url).toBe("https://telegram.example.com/hook");
  });

  it("Create (rel=nofollow anchors, /src/<ref> links)", async () => {
    expect(await html({ type: "telegram" }, "create", createPayload)).toBe(
      `[<a href="http://localhost:3000/test/repo" rel="nofollow">test/repo</a>] branch <a href="http://localhost:3000/test/repo/src/test" rel="nofollow">test</a> created`,
    );
  });

  it("Delete", async () => {
    expect(await html({ type: "telegram" }, "delete", deletePayload)).toBe(
      `[<a href="http://localhost:3000/test/repo" rel="nofollow">test/repo</a>] branch <a href="http://localhost:3000/test/repo/src/test" rel="nofollow">test</a> deleted`,
    );
  });

  it("Fork (escaped forkee name)", async () => {
    expect(await html({ type: "telegram" }, "fork", forkPayload)).toBe(
      `test/repo2 is forked to <a href="http://localhost:3000/test/repo" rel="nofollow">test/repo</a>`,
    );
  });

  it("Push (<br> line joins)", async () => {
    expect(await html({ type: "telegram" }, "push", pushPayload)).toBe(
      `[<a href="http://localhost:3000/test/repo" rel="nofollow">test/repo</a>:<a href="http://localhost:3000/test/repo/src/test" rel="nofollow">test</a>] 2 new commits<br>[<a href="http://localhost:3000/test/repo/commit/2020558fe2e34debb818a514715839cabd25e778" rel="nofollow">2020558</a>] commit message - user1<br>[<a href="http://localhost:3000/test/repo/commit/2020558fe2e34debb818a514715839cabd25e778" rel="nofollow">2020558</a>] commit message - user1`,
    );
  });

  it("Issue opened (<br><br> body join)", async () => {
    expect(await html({ type: "telegram" }, "issues", issuePayload("opened"))).toBe(
      `[<a href="http://localhost:3000/test/repo" rel="nofollow">test/repo</a>] Issue opened: <a href="http://localhost:3000/test/repo/issues/2" rel="nofollow">#2 crash</a> by <a href="https://try.gitea.io/user1" rel="nofollow">user1</a><br><br>issue body`,
    );
    expect(await html({ type: "telegram" }, "issues", issuePayload("closed"))).toBe(
      `[<a href="http://localhost:3000/test/repo" rel="nofollow">test/repo</a>] Issue closed: <a href="http://localhost:3000/test/repo/issues/2" rel="nofollow">#2 crash</a> by <a href="https://try.gitea.io/user1" rel="nofollow">user1</a>`,
    );
  });

  it("IssueComment / PullRequestComment", async () => {
    expect(await html({ type: "telegram" }, "issue_comment", issueCommentPayload)).toBe(
      `[<a href="http://localhost:3000/test/repo" rel="nofollow">test/repo</a>] New comment on issue <a href="http://localhost:3000/test/repo/issues/2" rel="nofollow">#2 crash</a> by <a href="https://try.gitea.io/user1" rel="nofollow">user1</a><br>more info needed`,
    );
    expect(await html({ type: "telegram" }, "pull_request_comment", pullRequestCommentPayload)).toBe(
      `[<a href="http://localhost:3000/test/repo" rel="nofollow">test/repo</a>] New comment on pull request <a href="http://localhost:3000/test/repo/pulls/12" rel="nofollow">#12 Fix bug</a> by <a href="https://try.gitea.io/user1" rel="nofollow">user1</a><br>changes requested`,
    );
  });

  it("PullRequest opened", async () => {
    expect(await html({ type: "telegram" }, "pull_request", pullRequestPayload("opened"))).toBe(
      `[<a href="http://localhost:3000/test/repo" rel="nofollow">test/repo</a>] Pull request opened: <a href="http://localhost:3000/test/repo/pulls/12" rel="nofollow">#12 Fix bug</a> by <a href="https://try.gitea.io/user1" rel="nofollow">user1</a><br>fixes bug #2`,
    );
  });

  it("Review approved (plain text)", async () => {
    expect(await html({ type: "telegram" }, "pull_request_review_approved", pullRequestPayload("reviewed"))).toBe(
      `[test/repo] Pull request review approved: #12 Fix bug<br>good job`,
    );
  });

  it("Repository created", async () => {
    expect(await html({ type: "telegram" }, "repository", repositoryPayload("created"))).toBe(
      `[<a href="http://localhost:3000/test/repo" rel="nofollow">test/repo</a>] Repository created`,
    );
  });

  it("Package", async () => {
    expect(await html({ type: "telegram" }, "package", packagePayload)).toBe(
      `Package created: <a href="http://localhost:3000/user1/-/packages/container/GiteaContainer/latest" rel="nofollow">GiteaContainer:latest</a> by <a href="https://try.gitea.io/user1" rel="nofollow">user1</a>`,
    );
  });

  it("Wiki (the &#39; entity survives sanitize)", async () => {
    expect(await html({ type: "telegram" }, "wiki", wikiPayload("created"))).toBe(
      `[<a href="http://localhost:3000/test/repo" rel="nofollow">test/repo</a>] New wiki page &#39;<a href="http://localhost:3000/test/repo/wiki/index" rel="nofollow">index</a>&#39; (Wiki change comment) by <a href="https://try.gitea.io/user1" rel="nofollow">user1</a>`,
    );
    expect(await html({ type: "telegram" }, "wiki", wikiPayload("deleted"))).toBe(
      `[<a href="http://localhost:3000/test/repo" rel="nofollow">test/repo</a>] Wiki page &#39;<a href="http://localhost:3000/test/repo/wiki/index" rel="nofollow">index</a>&#39; deleted by <a href="https://try.gitea.io/user1" rel="nofollow">user1</a>`,
    );
  });

  it("Release", async () => {
    expect(await html({ type: "telegram" }, "release", releasePayload)).toBe(
      `[<a href="http://localhost:3000/test/repo" rel="nofollow">test/repo</a>] Release created: <a href="http://localhost:3000/test/repo/releases/tag/v1.0" rel="nofollow">v1.0</a> by <a href="https://try.gitea.io/user1" rel="nofollow">user1</a>`,
    );
  });

  it("sanitizes stray tags (bluemonday's reachable surface: anchors keep nofollow, other tags drop)", async () => {
    // Data is html-escaped by htmlLinkFormatter BEFORE sanitize — a stray
    // tag in a FIELD reaches the sanitizer as entities (bluemonday round-trips
    // them idempotently), never as markup.
    expect(await html({ type: "telegram" }, "create", { ...createPayload, repository: { ...REPO, full_name: "<b>bold</b>repo" } })).toBe(
      `[<a href="http://localhost:3000/test/repo" rel="nofollow">&lt;b&gt;bold&lt;/b&gt;repo</a>] branch <a href="http://localhost:3000/test/repo/src/test" rel="nofollow">test</a> created`,
    );
  });
});

// ---------------------------------------------------------------------------
// msteams.go — TestMSTeamsPayloads goldens
// ---------------------------------------------------------------------------

describe("msteams requesters (msteams_test.go goldens)", () => {
  async function card(hook: Partial<ProviderPlanInput["hook"]>, event: string, payload: unknown): Promise<Record<string, unknown>> {
    const bodyJson = await body(hook, event, payload);
    return {
      title: bodyJson.title as string,
      themeColor: bodyJson.themeColor as string,
      sections: bodyJson.sections as Array<Record<string, unknown>>,
      potentialAction: bodyJson.potentialAction as Array<Record<string, unknown>>,
      type: bodyJson["@type"] as string,
    };
  }

  it("Create", async () => {
    const c = await card({ type: "msteams" }, "create", createPayload);
    expect(c.type).toBe("MessageCard");
    expect(c.title).toBe("[test/repo] branch test created");
    expect(c.themeColor).toBe("1ac600");
    const section = (c.sections as Array<Record<string, unknown>>)[0]!;
    const facts = section.facts as Array<Record<string, string>>;
    expect(facts[0]).toEqual({ name: "Repository:", value: "[test/repo](http://localhost:3000/test/repo)" });
    expect(facts[1]).toEqual({ name: "branch:", value: "test" });
    const targets = (c.potentialAction as Array<Record<string, unknown>>)[0]!.targets as Array<Record<string, string>>;
    expect(targets[0]!.uri).toBe("http://localhost:3000/test/repo/src/test");
  });

  it("Push", async () => {
    const c = await card({ type: "msteams" }, "push", pushPayload);
    expect(c.title).toBe("[test/repo:test] 2 new commits");
    expect(c.themeColor).toBe("1ac600");
    const section = (c.sections as Array<Record<string, unknown>>)[0]!;
    expect(section.activitySubtitle).toBe("user1");
    const facts = section.facts as Array<Record<string, string>>;
    expect(facts[1]).toEqual({ name: "Commit count:", value: "2" });
    expect(section.text).toBe(
      "[2020558](http://localhost:3000/test/repo/commit/2020558fe2e34debb818a514715839cabd25e778) commit message - user1\n\n[2020558](http://localhost:3000/test/repo/commit/2020558fe2e34debb818a514715839cabd25e778) commit message - user1",
    );
  });

  it("Issue opened", async () => {
    const c = await card({ type: "msteams" }, "issues", issuePayload("opened"));
    expect(c.title).toBe("[test/repo] Issue opened: #2 crash");
    expect(c.themeColor).toBe("eb6420");
    const facts = ((c.sections as Array<Record<string, unknown>>)[0]!.facts ?? []) as Array<Record<string, string>>;
    expect(facts[1]).toEqual({ name: "Issue #:", value: "2" });
  });

  it("Repository deleted pins the yellow arm", async () => {
    const c = await card({ type: "msteams" }, "repository", repositoryPayload("deleted"));
    expect(c.title).toBe("[test/repo] Repository deleted");
    expect(c.themeColor).toBe("ffd930"); // yellowColor — msteams diverges from discord's red
  });

  it("PR review_requested adds the Requested Reviewer fact (msteams.go:194-200)", async () => {
    const payload = {
      ...pullRequestPayload("review_requested"),
      requested_reviewer: { login: "reviewer2", full_name: "Reviewer Two" },
    };
    const c = await card({ type: "msteams" }, "pull_request", payload);
    const facts = ((c.sections as Array<Record<string, unknown>>)[0]!.facts ?? []) as Array<Record<string, string>>;
    expect(facts[1]).toEqual({ name: "Pull request:", value: "[#12](http://localhost:3000/test/repo/pulls/12)" });
    expect(facts[2]).toEqual({ name: "Requested Reviewer:", value: "reviewer2 (Reviewer Two)" });
  });
});

// ---------------------------------------------------------------------------
// feishu.go
// ---------------------------------------------------------------------------

describe("feishu requesters (feishu.go)", () => {
  async function feishuText(hook: Partial<ProviderPlanInput["hook"]>, event: string, payload: unknown): Promise<string> {
    const bodyJson = await body(hook, event, payload);
    return ((bodyJson.content as Record<string, unknown>).text ?? "") as string;
  }

  it("Create", async () => {
    expect(await feishuText({ type: "feishu" }, "create", createPayload)).toBe("[test/repo] branch test created");
  });

  it("Push (\\r\\n joins, TrimSpaced)", async () => {
    expect(await feishuText({ type: "feishu" }, "push", pushPayload)).toBe(
      "[test/repo:test] 2 new commits\r\n[2020558](http://localhost:3000/test/repo/commit/2020558fe2e34debb818a514715839cabd25e778) commit message - user1\r\n[2020558](http://localhost:3000/test/repo/commit/2020558fe2e34debb818a514715839cabd25e778) commit message - user1",
    );
  });

  it("Issue opened (getIssuesInfo layout)", async () => {
    expect(await feishuText({ type: "feishu" }, "issues", issuePayload("opened"))).toBe(
      "[Issue-test/repo #2]: opened\ncrash\nhttp://localhost:3000/test/repo/issues/2\nIssue by user1\nOperator: user1\nAssignees: user1\n\nissue body",
    );
  });

  it("no default headers (prepareJSONRequest false), no signature headers rendered", async () => {
    const result = await plan({ type: "feishu", secret: "" }, "push", pushPayload);
    if (result.kind !== "provider") throw new Error("expected provider plan");
    expect(result.defaultHeaders).toBe(false);
    const bodyJson = JSON.parse(result.body) as Record<string, unknown>;
    expect(bodyJson.msg_type).toBe("text");
    expect(bodyJson.timestamp).toBeUndefined();
    expect(bodyJson.sign).toBeUndefined();
    expect(Object.keys(bodyJson)).toEqual(["msg_type", "content"]);
  });

  it("embeds timestamp + sign when a secret is configured (feishuGenSign)", async () => {
    const result = await plan({ type: "feishu", secret: "shhh" }, "push", pushPayload);
    if (result.kind !== "provider") throw new Error("expected provider plan");
    const bodyJson = JSON.parse(result.body) as Record<string, unknown>;
    expect(typeof bodyJson.timestamp).toBe("number");
    expect(typeof bodyJson.sign).toBe("string");
    expect(bodyJson.sign).not.toBe("");
    // key="{timestamp}\n{secret}", HMAC-SHA256 over the empty message, base64.
    const { createHmac } = await import("node:crypto");
    const expected = createHmac("sha256", `${String(bodyJson.timestamp)}\nshhh`).update("").digest("base64");
    expect(bodyJson.sign).toBe(expected);
    expect(Object.keys(bodyJson)).toEqual(["timestamp", "sign", "msg_type", "content"]);
  });
});

// ---------------------------------------------------------------------------
// matrix.go — TestMatrixPayload / Test_getTxnID goldens
// ---------------------------------------------------------------------------

describe("matrix requesters (matrix_test.go goldens)", () => {
  const MATRIX_URL = "https://matrix.example.com/_matrix/client/r0/rooms/ROOM_ID/send/m.room.message";

  async function matrixParts(
    meta: string,
    event: string,
    payload: unknown,
  ): Promise<{ msgtype: unknown; body: unknown; formattedBody: unknown; commits: unknown; plan: Extract<Awaited<ReturnType<typeof plan>>, { kind: "provider" }> }> {
    const result = await plan({ type: "matrix", url: MATRIX_URL, meta }, event, payload);
    if (result.kind !== "provider") throw new Error("expected provider plan");
    const bodyJson = JSON.parse(result.body) as Record<string, unknown>;
    return {
      msgtype: bodyJson.msgtype,
      body: bodyJson.body,
      formattedBody: bodyJson.formatted_body,
      commits: bodyJson["io.gitea.commits"],
      plan: result,
    };
  }

  it("PUTs {url}/{txnID} with application/json + default headers (newMatrixRequest)", async () => {
    const { plan: result } = await matrixParts(JSON.stringify({ message_type: 0 }), "push", pushPayload);
    expect(result.method).toBe("PUT");
    expect(result.url.startsWith(`${MATRIX_URL}/`)).toBe(true);
    const txnId = result.url.slice(MATRIX_URL.length + 1);
    expect(txnId).toMatch(/^[0-9a-f]{40}$/); // sha1 of the trimmed body
    expect(result.contentType).toBe("application/json");
    expect(result.defaultHeaders).toBe(true);
  });

  it("Push body/markdown conversion + io.gitea.commits", async () => {
    const { body: bodyText, formattedBody, commits, msgtype } = await matrixParts(JSON.stringify({ message_type: 2 }), "push", pushPayload);
    expect(msgtype).toBe("m.text");
    expect(formattedBody).toBe(
      `[<a href="http://localhost:3000/test/repo">test/repo</a>] user1 pushed 2 commits to <a href="http://localhost:3000/test/repo/src/branch/test">test</a>:<br><a href="http://localhost:3000/test/repo/commit/2020558fe2e34debb818a514715839cabd25e778">2020558</a>: commit message - user1<br><a href="http://localhost:3000/test/repo/commit/2020558fe2e34debb818a514715839cabd25e778">2020558</a>: commit message - user1`,
    );
    expect(bodyText).toBe(
      `[[test/repo](http://localhost:3000/test/repo)] user1 pushed 2 commits to [test](http://localhost:3000/test/repo/src/branch/test):\n[2020558](http://localhost:3000/test/repo/commit/2020558fe2e34debb818a514715839cabd25e778): commit message - user1\n[2020558](http://localhost:3000/test/repo/commit/2020558fe2e34debb818a514715839cabd25e778): commit message - user1`,
    );
    expect(Array.isArray(commits)).toBe(true);
    expect((commits as unknown[]).length).toBe(2);
  });

  it("Issue opened", async () => {
    const { formattedBody } = await matrixParts("{}", "issues", issuePayload("opened"));
    expect(formattedBody).toBe(
      `[<a href="http://localhost:3000/test/repo">test/repo</a>] Issue opened: <a href="http://localhost:3000/test/repo/issues/2">#2 crash</a> by <a href="https://try.gitea.io/user1">user1</a>`,
    );
  });

  it("non-push events omit io.gitea.commits (omitempty)", async () => {
    const { commits } = await matrixParts("{}", "create", createPayload);
    expect(commits).toBeUndefined();
  });

  it("meta message_type maps 1→m.notice, 2→m.text, 0→\"\" (messageTypeText)", async () => {
    expect((await matrixParts(JSON.stringify({ message_type: 1 }), "create", createPayload)).msgtype).toBe("m.notice");
    expect((await matrixParts(JSON.stringify({ message_type: 2 }), "create", createPayload)).msgtype).toBe("m.text");
    expect((await matrixParts(JSON.stringify({ message_type: 0 }), "create", createPayload)).msgtype).toBe("");
  });

  it("empty meta fails like Go's Unmarshal (GetMatrixPayload meta json)", async () => {
    await expect(plan({ type: "matrix", meta: "" }, "push", pushPayload)).rejects.toThrow(
      "GetMatrixPayload meta json: unexpected end of JSON input",
    );
  });
});

// ---------------------------------------------------------------------------
// wechatwork.go (no upstream test file — derived from wechatwork.go)
// ---------------------------------------------------------------------------

describe("wechatwork requesters (wechatwork.go)", () => {
  async function content(hook: Partial<ProviderPlanInput["hook"]>, event: string, payload: unknown): Promise<string> {
    const bodyJson = await body(hook, event, payload);
    return ((bodyJson.markdown as Record<string, unknown>).content ?? "") as string;
  }

  it("Create", async () => {
    expect(await content({ type: "wechatwork" }, "create", createPayload)).toBe("[test/repo] branch test created");
  });

  it("Push (the never-assigned commitDesc renders the empty warning font)", async () => {
    const line =
      ` > [2020558](http://localhost:3000/test/repo/commit/2020558fe2e34debb818a514715839cabd25e778) \r\n ><font color="info">commit message</font> \n ><font color="warning">Author: user1</font>`;
    expect(await content({ type: "wechatwork" }, "push", pushPayload)).toBe(
      `# test/repo:test <font color="warning">    </font>\r\n\r\n${line}\n${line}`,
    );
  });

  it("Issue opened", async () => {
    expect(await content({ type: "wechatwork" }, "issues", issuePayload("opened"))).toBe(
      ` ><font color="info">[test/repo] Issue opened: #2 crash by user1</font>\n >issue body \n ><font color="warning"> #2 crash</font> \n [http://localhost:3000/test/repo/issues/2](http://localhost:3000/test/repo/issues/2)`,
    );
  });

  it("always serializes the text block with null mention lists (Go struct shape)", async () => {
    const bodyJson = await body({ type: "wechatwork" }, "create", createPayload);
    expect(bodyJson.msgtype).toBe("markdown");
    expect(bodyJson.text).toEqual({ content: "", mentioned_list: null, mentioned_mobile_list: null });
    expect(Object.keys(bodyJson)).toEqual(["msgtype", "text", "markdown"]);
  });
});

// ---------------------------------------------------------------------------
// packagist.go — TestPackagistPayload goldens
// ---------------------------------------------------------------------------

describe("packagist requesters (packagist.go)", () => {
  const PACKAGIST_META = JSON.stringify({ username: "user", api_token: "token", package_url: "https://packagist.org/packages/user/repo" });

  it("Push carries the package_url; every other event ships the zero payload", async () => {
    const pushed = await body({ type: "packagist", meta: PACKAGIST_META }, "push", pushPayload);
    expect(pushed).toEqual({ repository: { url: "https://packagist.org/packages/user/repo" } });

    const created = await body({ type: "packagist", meta: PACKAGIST_META }, "create", createPayload);
    expect(created).toEqual({ repository: { url: "" } });
  });

  it("empty meta fails (newpackagistRequest meta json)", async () => {
    await expect(plan({ type: "packagist", meta: "" }, "push", pushPayload)).rejects.toThrow(
      "newpackagistRequest meta json: unexpected end of JSON input",
    );
  });
});

// ---------------------------------------------------------------------------
// The newPayload dispatch + Go-JSON byte fidelity
// ---------------------------------------------------------------------------

describe("payload dispatch + serialization (payloader.go)", () => {
  it("an unsupported event fails with newPayload's text", async () => {
    await expect(plan({ type: "slack", meta: "{}" }, "irc", pushPayload)).rejects.toThrow(
      "newPayload unsupported event: irc",
    );
  });

  it("malformed stored payload fails with Go's unmarshal text", async () => {
    const result = planProviderRequest({
      hook: { type: "slack", url: "https://x.example", httpMethod: "POST", secret: "", meta: "{}" },
      event: "push",
      payloadText: "{not json",
      appUrl: "https://try.gitea.io",
    });
    await expect(result).rejects.toThrow("could not unmarshal payload: invalid character '{' looking for beginning of value");
  });

  it("HTML-escapes < > & like Go's Marshal (\\u003c \\u003e \\u0026)", async () => {
    const result = await plan({ type: "packagist", meta: JSON.stringify({ package_url: "https://p.example/a?b=1&c=<2>" }) }, "push", pushPayload);
    if (result.kind !== "provider") throw new Error("expected provider plan");
    expect(result.body).toBe(
      '{\n  "repository": {\n    "url": "https://p.example/a?b=1\\u0026c=\\u003c2\\u003e"\n  }\n}',
    );
  });

  it("honors the stored http_method (prepareJSONRequest reads w.HTTPMethod)", async () => {
    const result = await plan({ type: "dingtalk", httpMethod: "" }, "create", createPayload);
    if (result.kind !== "provider") throw new Error("expected provider plan");
    expect(result.method).toBe("POST");
  });
});
