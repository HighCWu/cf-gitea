/**
 * The per-provider webhook requesters — the census B-61 port of upstream's
 * `webhookRequesters` registry (services/webhook/webhook.go:30) and the nine
 * provider payload builders it dispatches to (services/webhook/{slack,
 * discord,dingtalk,telegram,msteams,feishu,matrix,wechatwork,packagist}.go at
 * the pin), on top of `newPayload` (payloader.go) and `prepareJSONRequest`
 * (payloader.go:101-122). Upstream behavior, verbatim:
 *
 *  - Deliver picks the requester per hook type; an UNREGISTERED type (and any
 *    payload-version-1 task) falls back to `newDefaultRequest` (:165-167) —
 *    ours returns {kind:"default"} for gitea/gogs/unknown types and the
 *    consumer's default path serves them.
 *  - EVERY json provider rides `prepareJSONRequest`: the REBUILT payload
 *    serialized with Go's 2-space MarshalIndent, the hook's stored HTTP method
 *    ("" → POST), `Content-Type: application/json`, and (except feishu) the
 *    full default header set signed over the REBUILT body bytes.
 *  - matrix PUTs `{url}/{txnID}` (txnID = sha1-hex of the trimmed body) with
 *    default headers (matrix.go:60 — "likely useless, but has always been sent
 *    historically").
 *  - telegram rewrites a `/sendMessage` URL path suffix to `/sendRichMessage`
 *    (telegram.go:214-224).
 *  - feishu sends NO default signature headers (:219) and embeds the
 *    timestamp+sign pair in the payload when a secret is configured (:213-217).
 *  - slack/discord/matrix/packagist parse their `webhooks.meta` JSON BEFORE the
 *    payload — an empty or malformed meta FAILS the delivery upstream (Go
 *    json.Unmarshal("") errors), exactly what API-created hooks of those types
 *    carry (the API builds meta for slack only; routers/api/v1/utils/hook.go
 *    addHook). Mirrored, not fixed.
 *
 * Request-construction errors throw `ProviderRequestError`; the consumer
 * records them as terminal failures wrapped in upstream's
 * "cannot create http request for webhook %s[%d %s]: %w" text (deliver.go:171).
 */

import {
  COLORS,
  appRoot,
  colorHex,
  getIssuesCommentInfo,
  escapeHtml,
  getIssueCommentPayloadInfo,
  getIssuesInfo,
  getIssuesPayloadInfo,
  getPackagePayloadInfo,
  getPullRequestInfo,
  getPullRequestPayloadInfo,
  getReleasePayloadInfo,
  getRepoRenamedFrom,
  getStatusPayloadInfo,
  getWikiPayloadInfo,
  getWorkflowJobPayloadInfo,
  getWorkflowRunPayloadInfo,
  goPathEscapeSegment,
  goQueryEscape,
  htmlLinkFormatter,
  noneLinkFormatter,
  parseHookPullRequestEventType,
  pathEscapeSegments,
  refShortName,
  refWebLinkPath,
  slackLinkFormatter,
  slackShortTextFormatter,
  slackTextFormatter,
  truncateRunes,
} from "./formatting";
import { goMarshalIndent } from "./go-json";
import { ProviderPayloadError, nonNil, num, parsePayloadByEvent, str, type ParsedPayload } from "./payload-shapes";

/** The requester-construction error (Deliver's wrap arm feeds it). */
export class ProviderRequestError extends Error {}

/** The hook fields the requesters read (the D1 `webhooks` row's slice). */
export interface ProviderHookShape {
  type: string;
  url: string;
  httpMethod: string;
  secret: string;
  meta: string;
}

export interface ProviderPlanInput {
  hook: ProviderHookShape;
  /** The wire event type (t.EventType) — the parse dispatch key. */
  event: string;
  /** The stored payload bytes (2-space gitea JSON). */
  payloadText: string;
  /** The instance origin, trailing-slash-stripped (the APP_URL convention). */
  appUrl: string;
  /** Delivery clock (feishu's timestamp field); defaults to now. */
  now?: Date;
}

/**
 * The delivery plan for one task:
 *  - `default`: the gitea/gogs/unknown-type arm — the consumer's existing
 *    `buildWebhookRequest` path (POST json / POST form / GET query).
 *  - `provider`: the rebuilt provider body + transport; `defaultHeaders`
 *    mirrors `prepareJSONRequest`'s flag (false only for feishu).
 */
export type ProviderRequestPlan =
  | { kind: "default" }
  | {
      kind: "provider";
      method: string;
      url: string;
      body: string;
      /** The exact bytes the default headers sign and the log records. */
      loggedBody: string;
      contentType: "application/json";
      defaultHeaders: boolean;
    };

/** Registered-requester probe — upstream `webhookRequesters[w.Type]` + nil check. */
const PROVIDER_REQUESTERS: ReadonlySet<string> = new Set([
  "slack",
  "discord",
  "dingtalk",
  "telegram",
  "msteams",
  "feishu",
  "matrix",
  "wechatwork",
  "packagist",
]);

export function hasProviderRequester(hookType: string): boolean {
  return PROVIDER_REQUESTERS.has(hookType);
}

/**
 * `Deliver`'s requester dispatch (:164-167): gitea/gogs and unknown types (and
 * payload version 1 — we only store v2) ride the default request; everything
 * else runs its provider requester, whose errors throw
 * `ProviderRequestError`/`ProviderPayloadError`.
 */
export async function planProviderRequest(input: ProviderPlanInput): Promise<ProviderRequestPlan> {
  const { hook } = input;
  if (!hasProviderRequester(hook.type)) {
    return { kind: "default" };
  }

  const appUrl = appRoot(input.appUrl);
  const parsed = parsePayloadByEvent(input.event, input.payloadText);
  const method = hook.httpMethod === "" ? "POST" : hook.httpMethod.toUpperCase();

  switch (hook.type) {
    case "slack":
      return jsonPlan(method, hook.url, buildSlackBody(parsed, hook.meta, appUrl), true);
    case "discord":
      return jsonPlan(method, hook.url, buildDiscordBody(parsed, hook.meta, appUrl), true);
    case "dingtalk":
      return jsonPlan(method, hook.url, buildDingtalkBody(parsed), true);
    case "telegram":
      return jsonPlan(method, telegramUrl(hook.url), buildTelegramBody(parsed, appUrl), true);
    case "msteams":
      return jsonPlan(method, hook.url, buildMSTeamsBody(parsed, appUrl), true);
    case "feishu":
      return jsonPlan(
        method,
        hook.url,
        await buildFeishuBody(parsed, appUrl, hook.secret, input.now ?? new Date()),
        false, // prepareJSONRequest(payload, w, t, false) — no default headers
      );
    case "matrix":
      return await matrixPlan(hook, parsed, appUrl);
    case "wechatwork":
      return jsonPlan(method, hook.url, buildWechatworkBody(parsed), true);
    case "packagist":
      return jsonPlan(method, hook.url, buildPackagistBody(parsed, hook.meta), true);
    default:
      // Unreachable (hasProviderRequester gate) — kept for exhaustiveness.
      return { kind: "default" };
  }
}

function jsonPlan(method: string, url: string, body: string, defaultHeaders: boolean): ProviderRequestPlan {
  return { kind: "provider", method, url, body, loggedBody: body, contentType: "application/json", defaultHeaders };
}

// ---------------------------------------------------------------------------
// Meta parsing — the provider-requester front door
// ---------------------------------------------------------------------------

/** Go json.Unmarshal's empty/invalid input texts, Go-style. */
function parseMetaJson(meta: string, who: string): Record<string, unknown> {
  const trimmed = meta.trim();
  if (trimmed === "") {
    throw new ProviderRequestError(`${who}: unexpected end of JSON input`);
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new ProviderRequestError(`${who}: json: cannot unmarshal value into Go value of type struct`);
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof ProviderRequestError) throw error;
    throw new ProviderRequestError(`${who}: invalid character '${trimmed[0] ?? ""}' looking for beginning of value`);
  }
}

function metaString(meta: Record<string, unknown>, key: string): string {
  const value = meta[key];
  return typeof value === "string" ? value : "";
}

function metaNumber(meta: Record<string, unknown>, key: string): number {
  const value = meta[key];
  return typeof value === "number" ? value : 0;
}

// ---------------------------------------------------------------------------
// slack.go
// ---------------------------------------------------------------------------

interface SlackMeta {
  channel: string;
  username: string;
  icon_url: string;
  color: string;
}

interface SlackAttachment {
  fallback: string;
  color: string;
  author_name?: string;
  author_link?: string;
  author_icon?: string;
  title: string;
  title_link: string;
  text: string;
}

/** `SlackLinkToRef` (slack.go:98-103). */
function slackLinkToRef(repoUrl: string, ref: string): string {
  return slackLinkFormatter(`${repoUrl}/src/${refWebLinkPath(ref)}`, refShortName(ref));
}

function slackAttachment(
  info: { text: string; issueTitle?: string; extraMarkdown?: string; color: number },
  options: {
    issueTitle?: string;
    sender: { login?: string; html_url?: string; avatar_url?: string } | null | undefined;
    titleLink: string;
    text: string;
  },
): SlackAttachment {
  return {
    fallback: "",
    color: colorHex(info.color),
    author_name: str(options.sender?.login),
    author_link: str(options.sender?.html_url),
    author_icon: str(options.sender?.avatar_url),
    title: str(options.issueTitle),
    title_link: options.titleLink,
    text: options.text,
  };
}

function buildSlackBody(parsed: ParsedPayload, meta: string, appUrl: string): string {
  const metaJson = parseMetaJson(meta, "newSlackRequest meta json");
  const conf: SlackMeta = {
    channel: metaString(metaJson, "channel"),
    username: metaString(metaJson, "username"),
    icon_url: metaString(metaJson, "icon_url"),
    color: metaString(metaJson, "color"),
  };

  let text = "";
  let attachments: SlackAttachment[] | null = null;

  switch (parsed.event) {
    case "create": {
      const p = parsed.payload;
      const repoLink = slackLinkFormatter(str(p.repository?.html_url), str(p.repository?.full_name));
      const refLink = slackLinkToRef(str(p.repository?.html_url), str(p.ref));
      text = `[${repoLink}:${refLink}] ${str(p.ref_type)} created by ${str(p.sender?.login)}`;
      break;
    }
    case "delete": {
      const p = parsed.payload;
      const refName = refShortName(str(p.ref));
      const repoLink = slackLinkFormatter(str(p.repository?.html_url), str(p.repository?.full_name));
      text = `[${repoLink}:${refName}] ${str(p.ref_type)} deleted by ${str(p.sender?.login)}`;
      break;
    }
    case "fork": {
      const p = parsed.payload;
      const baseLink = slackLinkFormatter(str(p.forkee?.html_url), str(p.forkee?.full_name));
      const forkLink = slackLinkFormatter(str(p.repository?.html_url), str(p.repository?.full_name));
      text = `${baseLink} is forked to ${forkLink}`;
      break;
    }
    case "push": {
      const p = parsed.payload;
      const total = num(p.total_commits);
      const commitDesc = total === 1 ? "1 new commit" : `${total} new commits`;
      const commitString = str(p.compare_url) !== "" ? slackLinkFormatter(str(p.compare_url), commitDesc) : commitDesc;
      const repoLink = slackLinkFormatter(str(p.repository?.html_url), str(p.repository?.full_name));
      const branchLink = slackLinkToRef(str(p.repository?.html_url), str(p.ref));
      text = `[${repoLink}:${branchLink}] ${commitString} pushed by ${str(p.pusher?.login)}`;

      const lines: string[] = [];
      for (const commit of p.commits ?? []) {
        lines.push(
          `${slackLinkFormatter(str(commit.url), str(commit.id).slice(0, 7))}: ${slackShortTextFormatter(str(commit.message))} - ${slackTextFormatter(str(commit.author?.name))}`,
        );
      }
      attachments = [
        {
          fallback: "",
          color: conf.color,
          author_name: str(p.pusher?.login),
          author_link: str(p.pusher?.html_url),
          author_icon: str(p.pusher?.avatar_url),
          title: str(p.repository?.html_url),
          title_link: str(p.repository?.html_url),
          text: lines.join("\n"),
        },
      ];
      break;
    }
    case "issues": {
      const p = parsed.payload;
      const info = getIssuesPayloadInfo(p, slackLinkFormatter, true, appUrl);
      text = info.text;
      if (info.extraMarkdown !== "") {
        attachments = [
          slackAttachment(info, {
            sender: p.sender,
            titleLink: str(p.issue?.html_url),
            text: slackTextFormatter(str(info.extraMarkdown)),
          }),
        ];
      }
      break;
    }
    case "issue_comment": {
      const p = parsed.payload;
      const info = getIssueCommentPayloadInfo(p, slackLinkFormatter, true, appUrl);
      text = info.text;
      attachments = [
        slackAttachment(
          { ...info, color: info.color },
          {
            sender: p.sender,
            titleLink: str(p.comment?.html_url),
            text: slackTextFormatter(str(p.comment?.body)),
          },
        ),
      ];
      break;
    }
    case "pull_request": {
      const p = parsed.payload;
      const info = getPullRequestPayloadInfo(p, slackLinkFormatter, true, appUrl);
      text = info.text;
      // The upstream quirk verbatim (slack.go:256-258): the ""-gate reads the
      // info's extraMarkdown, but the attachment text re-reads the PR BODY.
      if (info.extraMarkdown !== "") {
        attachments = [
          slackAttachment(info, {
            sender: p.sender,
            titleLink: str(p.pull_request?.html_url),
            text: slackTextFormatter(str(p.pull_request?.body)),
          }),
        ];
      }
      break;
    }
    case "pull_request_review": {
      const p = parsed.payload;
      const action = parseHookPullRequestEventType(parsed.reviewEvent);
      if (action === null) throw new ProviderPayloadError("unknown event type");
      const senderLink = slackLinkFormatter(appUrl + str(p.sender?.login), str(p.sender?.login));
      const title = `#${num(p.number)} ${str(p.pull_request?.title)}`;
      const titleLink = `${str(p.repository?.html_url)}/pulls/${num(p.number)}`;
      const repoLink = slackLinkFormatter(str(p.repository?.html_url), str(p.repository?.full_name));
      text = `[${repoLink}] Pull request review ${action}: [${title}](${titleLink}) by ${senderLink}`;
      break;
    }
    case "repository": {
      const p = parsed.payload;
      const senderLink = slackLinkFormatter(appUrl + str(p.sender?.login), str(p.sender?.login));
      const repoLink = slackLinkFormatter(str(p.repository?.html_url), str(p.repository?.full_name));
      switch (str(p.action)) {
        case "created":
          text = `[${repoLink}] Repository created by ${senderLink}`;
          break;
        case "deleted":
          text = `[${repoLink}] Repository deleted by ${senderLink}`;
          break;
        case "renamed":
          text = `[${repoLink}] Repository renamed from ${getRepoRenamedFrom(p)} by ${senderLink}`;
          break;
      }
      break;
    }
    case "wiki": {
      const info = getWikiPayloadInfo(parsed.payload, slackLinkFormatter, true, appUrl);
      text = info.text;
      break;
    }
    case "release": {
      const info = getReleasePayloadInfo(parsed.payload, slackLinkFormatter, true, appUrl);
      text = info.text;
      break;
    }
    case "package": {
      const info = getPackagePayloadInfo(parsed.payload, slackLinkFormatter, true, appUrl);
      text = info.text;
      break;
    }
    case "status": {
      const info = getStatusPayloadInfo(parsed.payload, slackLinkFormatter, true, appUrl);
      text = info.text;
      break;
    }
    case "workflow_run": {
      const info = getWorkflowRunPayloadInfo(parsed.payload, slackLinkFormatter, true, appUrl);
      text = info.text;
      break;
    }
    case "workflow_job": {
      const info = getWorkflowJobPayloadInfo(parsed.payload, slackLinkFormatter, true, appUrl);
      text = info.text;
      break;
    }
  }

  // Field order mirrors the Go struct (SlackPayload, slack.go:39-47); a nil
  // attachment slice marshals as null.
  const payload = {
    channel: conf.channel,
    text,
    username: conf.username,
    icon_url: conf.icon_url,
    unfurl_links: 0,
    link_names: 0,
    attachments,
  };
  return goMarshalIndent(payload);
}

// ---------------------------------------------------------------------------
// discord.go
// ---------------------------------------------------------------------------

/** `discordDescriptionCharactersLimit` (discord.go:109). */
const DISCORD_DESCRIPTION_LIMIT = 2000;

function buildDiscordBody(parsed: ParsedPayload, meta: string, appUrl: string): string {
  const metaJson = parseMetaJson(meta, "newDiscordRequest meta json");
  const username = metaString(metaJson, "username");
  const avatarUrl = metaString(metaJson, "icon_url");

  let title = "";
  let text = "";
  let url = "";
  let color = 0;

  const setEmbed = (t: string, txt: string, u: string, c: number): void => {
    title = t;
    text = txt;
    url = u;
    color = c;
  };

  switch (parsed.event) {
    case "create": {
      const p = parsed.payload;
      const refName = refShortName(str(p.ref));
      setEmbed(
        `[${str(p.repository?.full_name)}] ${str(p.ref_type)} ${refName} created`,
        "",
        `${str(p.repository?.html_url)}/src/${pathEscapeSegments(refName)}`,
        COLORS.green,
      );
      break;
    }
    case "delete": {
      const p = parsed.payload;
      const refName = refShortName(str(p.ref));
      setEmbed(
        `[${str(p.repository?.full_name)}] ${str(p.ref_type)} ${refName} deleted`,
        "",
        `${str(p.repository?.html_url)}/src/${pathEscapeSegments(refName)}`,
        COLORS.red,
      );
      break;
    }
    case "fork": {
      const p = parsed.payload;
      setEmbed(
        `${str(p.forkee?.full_name)} is forked to ${str(p.repository?.full_name)}`,
        "",
        str(p.repository?.html_url),
        COLORS.green,
      );
      break;
    }
    case "push": {
      const p = parsed.payload;
      const branchName = refShortName(str(p.ref));
      const total = num(p.total_commits);
      const commitDesc = total === 1 ? "1 new commit" : `${total} new commits`;
      let titleLink = total === 1 ? str(nonNil(p.commits, "push.commits")[0]?.url) : str(p.compare_url);
      if (titleLink === "") {
        titleLink = `${str(p.repository?.html_url)}/src/${pathEscapeSegments(branchName)}`;
      }
      const lines: string[] = [];
      for (const commit of p.commits ?? []) {
        // The summary line only (discord.go:166), rune-truncated at 50 with a
        // 47-rune prefix + "..." (the %.47s arm, :169-171).
        let message = str(commit.message).split("\n")[0] ?? "";
        message = message.replace(/\r+$/, "");
        if ([...message].length > 50) {
          message = `${[...message].slice(0, 47).join("")}...`;
        }
        lines.push(`[${str(commit.id).slice(0, 7)}](${str(commit.url)}) ${message} - ${str(commit.author?.name)}`);
      }
      setEmbed(`[${str(p.repository?.full_name)}:${branchName}] ${commitDesc}`, lines.join("\n"), titleLink, COLORS.green);
      break;
    }
    case "issues": {
      const p = parsed.payload;
      const info = getIssuesPayloadInfo(p, noneLinkFormatter, false, appUrl);
      setEmbed(info.text, str(info.extraMarkdown), str(p.issue?.html_url), info.color);
      break;
    }
    case "issue_comment": {
      const p = parsed.payload;
      const info = getIssueCommentPayloadInfo(p, noneLinkFormatter, false, appUrl);
      setEmbed(info.text, str(p.comment?.body), str(p.comment?.html_url), info.color);
      break;
    }
    case "pull_request": {
      const p = parsed.payload;
      const info = getPullRequestPayloadInfo(p, noneLinkFormatter, false, appUrl);
      setEmbed(info.text, str(info.extraMarkdown), str(p.pull_request?.html_url), info.color);
      break;
    }
    case "pull_request_review": {
      const p = parsed.payload;
      const action = parseHookPullRequestEventType(parsed.reviewEvent);
      if (action === null) throw new ProviderPayloadError("unknown event type");
      const reviewColor =
        parsed.reviewEvent === "pull_request_review_approved"
          ? COLORS.green
          : parsed.reviewEvent === "pull_request_review_rejected"
            ? COLORS.red
            : parsed.reviewEvent === "pull_request_review_comment"
              ? COLORS.grey
              : COLORS.yellow;
      setEmbed(
        `[${str(p.repository?.full_name)}] Pull request review ${action}: #${num(p.number)} ${str(p.pull_request?.title)}`,
        str(p.review?.content),
        str(p.pull_request?.html_url),
        reviewColor,
      );
      break;
    }
    case "repository": {
      const p = parsed.payload;
      switch (str(p.action)) {
        case "created":
          setEmbed(`[${str(p.repository?.full_name)}] Repository created`, "", str(p.repository?.html_url), COLORS.green);
          break;
        case "deleted":
          setEmbed(`[${str(p.repository?.full_name)}] Repository deleted`, "", "", COLORS.red);
          break;
        case "renamed":
          setEmbed(
            `[${str(p.repository?.full_name)}] Repository renamed from ${getRepoRenamedFrom(p)}`,
            "",
            str(p.repository?.html_url),
            COLORS.green,
          );
          break;
      }
      break;
    }
    case "wiki": {
      const p = parsed.payload;
      const info = getWikiPayloadInfo(p, noneLinkFormatter, false, appUrl);
      const htmlLink = `${str(p.repository?.html_url)}/wiki/${goPathEscapeSegment(str(p.page))}`;
      const description = str(p.action) !== "deleted" ? str(p.comment) : "";
      setEmbed(info.text, description, htmlLink, info.color);
      break;
    }
    case "release": {
      const p = parsed.payload;
      const info = getReleasePayloadInfo(p, noneLinkFormatter, false, appUrl);
      setEmbed(info.text, str(p.release?.body), str(p.release?.html_url), info.color);
      break;
    }
    case "package": {
      const p = parsed.payload;
      const info = getPackagePayloadInfo(p, noneLinkFormatter, false, appUrl);
      setEmbed(info.text, "", str(p.package?.html_url), info.color);
      break;
    }
    case "status": {
      const p = parsed.payload;
      const info = getStatusPayloadInfo(p, noneLinkFormatter, false, appUrl);
      setEmbed(info.text, "", str(p.target_url), info.color);
      break;
    }
    case "workflow_run": {
      const p = parsed.payload;
      const info = getWorkflowRunPayloadInfo(p, noneLinkFormatter, false, appUrl);
      setEmbed(info.text, "", str(p.workflow_run?.html_url), info.color);
      break;
    }
    case "workflow_job": {
      const p = parsed.payload;
      const info = getWorkflowJobPayloadInfo(p, noneLinkFormatter, false, appUrl);
      setEmbed(info.text, "", str(p.workflow_job?.html_url), info.color);
      break;
    }
  }

  const sender = senderOf(parsed);
  // Field order mirrors the Go structs (discord.go:26-71): wait/content/tts
  // always serialize; username/avatar_url are omitempty; fields nil → null.
  const payload = {
    wait: false,
    content: "",
    ...(username !== "" ? { username } : {}),
    ...(avatarUrl !== "" ? { avatar_url: avatarUrl } : {}),
    tts: false,
    embeds: [
      {
        title,
        description: truncateRunes(text, DISCORD_DESCRIPTION_LIMIT),
        url,
        color,
        footer: { text: "" },
        author: {
          name: str(sender?.login),
          url: appUrl + str(sender?.login),
          icon_url: str(sender?.avatar_url),
        },
        fields: null,
      },
    ],
  };
  return goMarshalIndent(payload);
}

function senderOf(parsed: ParsedPayload): { login?: string; full_name?: string; avatar_url?: string; html_url?: string } | null | undefined {
  switch (parsed.event) {
    case "create":
    case "delete":
    case "fork":
    case "issues":
    case "issue_comment":
    case "pull_request":
    case "pull_request_review":
    case "repository":
    case "release":
    case "wiki":
    case "package":
    case "status":
    case "workflow_run":
    case "workflow_job":
      return parsed.payload.sender;
    case "push":
      return parsed.payload.sender;
  }
}

// ---------------------------------------------------------------------------
// dingtalk.go (+ the lunny/dingtalk_webhook Payload struct at the pin)
// ---------------------------------------------------------------------------

interface DingtalkPayload {
  msgtype: string;
  text: { content: string };
  link: { text: string; title: string; picUrl: string; messageUrl: string };
  markdown: { text: string; title: string };
  actionCard: {
    text: string;
    title: string;
    hideAvatar: string;
    btnOrientation: string;
    singleTitle: string;
    singleURL: string;
    btns: null;
  };
  feedCard: { links: null };
  at: { atMobiles: null; isAtAll: boolean };
}

function emptyDingtalkPayload(msgtype: string): DingtalkPayload {
  return {
    msgtype,
    text: { content: "" },
    link: { text: "", title: "", picUrl: "", messageUrl: "" },
    markdown: { text: "", title: "" },
    actionCard: {
      text: "",
      title: "",
      hideAvatar: "",
      btnOrientation: "",
      singleTitle: "",
      singleURL: "",
      btns: null,
    },
    feedCard: { links: null },
    at: { atMobiles: null, isAtAll: false },
  };
}

/** Go strings.TrimSpace — trims Unicode whitespace on both ends. */
function trimSpace(text: string): string {
  return text.trim();
}

/** `createDingtalkPayload` (dingtalk.go:194-208). */
function dingtalkActionCard(title: string, text: string, singleTitle: string, singleUrl: string): DingtalkPayload {
  const payload = emptyDingtalkPayload("actionCard");
  payload.actionCard = {
    text: trimSpace(text),
    title: trimSpace(title),
    hideAvatar: "0",
    btnOrientation: "",
    singleTitle,
    // The browser-open deep link (dingtalk.go:203-205).
    singleURL: `dingtalk://dingtalkclient/page/link?pc_slide=false&url=${goQueryEscape(singleUrl)}`,
    btns: null,
  };
  return payload;
}

/** DingTalk's Go-truth commit line (dingtalk.go:77-88) — \r\n separators. */
function dingtalkCommitLines(push: { commits?: Array<{ id?: string; url?: string; message?: string; author?: { name?: string } | null } | null> | null }): string {
  const lines: string[] = [];
  for (const commit of push.commits ?? []) {
    const authorName = commit?.author != null ? ` - ${str(commit.author.name)}` : "";
    lines.push(`[${str(commit?.id).slice(0, 7)}](${str(commit?.url)}) ${trimRightNewlines(str(commit?.message))}${authorName}`);
  }
  return lines.join("\r\n");
}

/** Go strings.TrimRight(message, "\r\n"). */
function trimRightNewlines(text: string): string {
  return text.replace(/[\r\n]+$/, "");
}

function buildDingtalkBody(parsed: ParsedPayload): string {
  let payload: DingtalkPayload;

  switch (parsed.event) {
    case "create": {
      const p = parsed.payload;
      const refName = refShortName(str(p.ref));
      const title = `[${str(p.repository?.full_name)}] ${str(p.ref_type)} ${refName} created`;
      payload = dingtalkActionCard(
        title,
        title,
        `view ref ${refName}`,
        `${str(p.repository?.html_url)}/src/${pathEscapeSegments(refName)}`,
      );
      break;
    }
    case "delete": {
      const p = parsed.payload;
      const refName = refShortName(str(p.ref));
      const title = `[${str(p.repository?.full_name)}] ${str(p.ref_type)} ${refName} deleted`;
      payload = dingtalkActionCard(
        title,
        title,
        `view ref ${refName}`,
        `${str(p.repository?.html_url)}/src/${pathEscapeSegments(refName)}`,
      );
      break;
    }
    case "fork": {
      const p = parsed.payload;
      const title = `${str(p.forkee?.full_name)} is forked to ${str(p.repository?.full_name)}`;
      payload = dingtalkActionCard(title, title, `view forked repo ${str(p.repository?.full_name)}`, str(p.repository?.html_url));
      break;
    }
    case "push": {
      const p = parsed.payload;
      const branchName = refShortName(str(p.ref));
      const total = num(p.total_commits);
      const commitDesc = total === 1 ? "1 new commit" : `${total} new commits`;
      let titleLink: string;
      let linkText: string;
      if (total === 1) {
        titleLink = str(nonNil(p.commits, "push.commits")[0]?.url);
        linkText = "view commit";
      } else {
        titleLink = str(p.compare_url);
        linkText = "view commits";
      }
      if (titleLink === "") {
        titleLink = `${str(p.repository?.html_url)}/src/${pathEscapeSegments(branchName)}`;
      }
      const title = `[${str(p.repository?.full_name)}:${branchName}] ${commitDesc}`;
      payload = dingtalkActionCard(title, dingtalkCommitLines(p), linkText, titleLink);
      break;
    }
    case "issues": {
      const p = parsed.payload;
      const info = getIssuesPayloadInfo(p, noneLinkFormatter, true, "");
      const text = `${info.text}\r\n\r\n${str(info.extraMarkdown)}`;
      payload = dingtalkActionCard(str(info.issueTitle), text, "view issue", str(p.issue?.html_url));
      break;
    }
    case "issue_comment": {
      const p = parsed.payload;
      const info = getIssueCommentPayloadInfo(p, noneLinkFormatter, true, "");
      const text = `${info.text}\r\n\r\n${str(p.comment?.body)}`;
      payload = dingtalkActionCard(info.issueTitle, text, "view issue comment", str(p.comment?.html_url));
      break;
    }
    case "pull_request": {
      const p = parsed.payload;
      const info = getPullRequestPayloadInfo(p, noneLinkFormatter, true, "");
      const text = `${info.text}\r\n\r\n${str(info.extraMarkdown)}`;
      payload = dingtalkActionCard(str(info.issueTitle), text, "view pull request", str(p.pull_request?.html_url));
      break;
    }
    case "pull_request_review": {
      const p = parsed.payload;
      const action = parseHookPullRequestEventType(parsed.reviewEvent);
      if (action === null) throw new ProviderPayloadError("unknown event type");
      const title = `[${str(p.repository?.full_name)}] Pull request review ${action} : #${num(p.number)} ${str(p.pull_request?.title)}`;
      const text = str(p.review?.content);
      payload = dingtalkActionCard(title, `${title}\r\n\r\n${text}`, "view pull request", str(p.pull_request?.html_url));
      break;
    }
    case "repository": {
      const p = parsed.payload;
      switch (str(p.action)) {
        case "created": {
          const title = `[${str(p.repository?.full_name)}] Repository created`;
          payload = dingtalkActionCard(title, title, "view repository", str(p.repository?.html_url));
          break;
        }
        case "deleted": {
          payload = emptyDingtalkPayload("text");
          payload.text.content = `[${str(p.repository?.full_name)}] Repository deleted`;
          break;
        }
        case "renamed": {
          const title = `[${str(p.repository?.full_name)}] Repository renamed from ${getRepoRenamedFrom(p)}`;
          payload = dingtalkActionCard(title, title, "view repository", str(p.repository?.html_url));
          break;
        }
        default:
          payload = emptyDingtalkPayload("");
      }
      break;
    }
    case "release": {
      const info = getReleasePayloadInfo(parsed.payload, noneLinkFormatter, true, "");
      payload = dingtalkActionCard(info.text, info.text, "view release", str(parsed.payload.release?.html_url));
      break;
    }
    case "package": {
      const info = getPackagePayloadInfo(parsed.payload, noneLinkFormatter, true, "");
      payload = dingtalkActionCard(info.text, info.text, "view package", str(parsed.payload.package?.html_url));
      break;
    }
    case "status": {
      const info = getStatusPayloadInfo(parsed.payload, noneLinkFormatter, true, "");
      payload = dingtalkActionCard(info.text, info.text, "Status Changed", str(parsed.payload.target_url));
      break;
    }
    case "workflow_run": {
      const info = getWorkflowRunPayloadInfo(parsed.payload, noneLinkFormatter, true, "");
      payload = dingtalkActionCard(info.text, info.text, "Workflow Run", str(parsed.payload.workflow_run?.html_url));
      break;
    }
    case "workflow_job": {
      const info = getWorkflowJobPayloadInfo(parsed.payload, noneLinkFormatter, true, "");
      payload = dingtalkActionCard(info.text, info.text, "Workflow Job", str(parsed.payload.workflow_job?.html_url));
      break;
    }
    default:
      payload = emptyDingtalkPayload("");
  }

  return goMarshalIndent(payload);
}

// ---------------------------------------------------------------------------
// telegram.go
// ---------------------------------------------------------------------------

/** `newTelegramRequest`'s URL rewrite (telegram.go:214-224). */
function telegramUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  if (url.pathname.endsWith("/sendMessage")) {
    url.pathname = `${url.pathname.slice(0, -"/sendMessage".length)}/sendRichMessage`;
    return url.toString();
  }
  return rawUrl;
}

/**
 * `createTelegramPayloadHTML` (telegram.go:202-212) — markup.Sanitize is
 * bluemonday's default policy upstream (sanitizer_default.go). The delivery
 * worker's HTML is always produced by `htmlLinkFormatter` (escaped href/text)
 * plus `<br>` and html-escaped text, so the policy's REACHABLE transformation
 * on that input is exactly: anchors survive with `rel="nofollow"` appended,
 * any other element tag is dropped (inner text kept), entities pass through.
 * This reduced sanitizer implements precisely that surface and nothing more —
 * a stored payload smuggling other tags gets them stripped (never rendered).
 */
function sanitizeTelegramHtml(htmlText: string): string {
  return htmlText
    .replace(/<a\s[^>]*?href="([^">]*?)"[^>]*>/gi, (tag: string, href: string) => {
      if (/rel=/i.test(tag)) return tag;
      return `<a href="${href}" rel="nofollow">`;
    })
    .replace(/<\/?(?!a\b|br\b)[a-zA-Z][^>]*>/g, "")
    .split(/(<[^>]+>)/g)
    .map((part) => (part.startsWith("<") ? part : escapeText(part)))
    .join("");
}

/** bluemonday's text-node re-encoding: raw quotes encode; entities (no raw
 *  quote bytes) and bare words pass through untouched. */
function escapeText(text: string): string {
  return text.replaceAll("'", "&#39;").replaceAll('"', "&#34;");
}

function telegramHtmlPayload(msgHtml: string): string {
  const trimmed = trimSpace(msgHtml);
  const sanitized = sanitizeTelegramHtml(trimmed)
    .replaceAll("\r\n", "<br>")
    .replaceAll("\r", "<br>")
    .replaceAll("\n", "<br>");
  return goMarshalIndent({ rich_message: { html: sanitized } });
}

function buildTelegramBody(parsed: ParsedPayload, appUrl: string): string {
  switch (parsed.event) {
    case "create": {
      const p = parsed.payload;
      const refName = refShortName(str(p.ref));
      const title = `[${htmlLinkFormatter(str(p.repository?.html_url), str(p.repository?.full_name))}] ${escapeHtml(str(p.ref_type))} ${htmlLinkFormatter(
        `${str(p.repository?.html_url)}/src/${pathEscapeSegments(refName)}`,
        refName,
      )} created`;
      return telegramHtmlPayload(title);
    }
    case "delete": {
      const p = parsed.payload;
      const refName = refShortName(str(p.ref));
      const title = `[${htmlLinkFormatter(str(p.repository?.html_url), str(p.repository?.full_name))}] ${escapeHtml(str(p.ref_type))} ${htmlLinkFormatter(
        `${str(p.repository?.html_url)}/src/${pathEscapeSegments(refName)}`,
        refName,
      )} deleted`;
      return telegramHtmlPayload(title);
    }
    case "fork": {
      const p = parsed.payload;
      const title = `${escapeHtml(str(p.forkee?.full_name))} is forked to ${htmlLinkFormatter(str(p.repository?.html_url), str(p.repository?.full_name))}`;
      return telegramHtmlPayload(title);
    }
    case "push": {
      const p = parsed.payload;
      const branchName = refShortName(str(p.ref));
      const total = num(p.total_commits);
      let titleLink: string;
      let commitDesc: string;
      if (total === 1) {
        commitDesc = "1 new commit";
        titleLink = str(nonNil(p.commits, "push.commits")[0]?.url);
      } else {
        commitDesc = `${total} new commits`;
        titleLink = str(p.compare_url);
      }
      if (titleLink === "") {
        titleLink = `${str(p.repository?.html_url)}/src/${pathEscapeSegments(branchName)}`;
      }
      let html =
        `[${htmlLinkFormatter(str(p.repository?.html_url), str(p.repository?.full_name))}:${htmlLinkFormatter(titleLink, branchName)}] ` +
        escapeHtml(commitDesc);
      for (const commit of p.commits ?? []) {
        html += `\n[${htmlLinkFormatter(str(commit.url), str(commit?.id).slice(0, 7))}] ${escapeHtml(trimRightNewlines(str(commit.message)))}`;
        if (commit.author != null) {
          html += ` - ${escapeHtml(str(commit.author.name))}`;
        }
      }
      return telegramHtmlPayload(html);
    }
    case "issues": {
      const p = parsed.payload;
      const info = getIssuesPayloadInfo(p, htmlLinkFormatter, true, appUrl);
      return telegramHtmlPayload(`${info.text}\n\n${escapeHtml(str(info.extraMarkdown))}`);
    }
    case "issue_comment": {
      const p = parsed.payload;
      const info = getIssueCommentPayloadInfo(p, htmlLinkFormatter, true, appUrl);
      return telegramHtmlPayload(`${info.text}\n${escapeHtml(str(p.comment?.body))}`);
    }
    case "pull_request": {
      const p = parsed.payload;
      const info = getPullRequestPayloadInfo(p, htmlLinkFormatter, true, appUrl);
      return telegramHtmlPayload(`${info.text}\n${escapeHtml(str(info.extraMarkdown))}`);
    }
    case "pull_request_review": {
      const p = parsed.payload;
      const action = parseHookPullRequestEventType(parsed.reviewEvent);
      if (action === null) throw new ProviderPayloadError("unknown event type");
      const text = `[${escapeHtml(str(p.repository?.full_name))}] Pull request review ${escapeHtml(action)}: #${num(p.number)} ${escapeHtml(
        str(p.pull_request?.title),
      )}`;
      return telegramHtmlPayload(`${text}\n${escapeHtml(str(p.review?.content))}`);
    }
    case "repository": {
      const p = parsed.payload;
      let title: string;
      switch (str(p.action)) {
        case "created":
          title = `[${htmlLinkFormatter(str(p.repository?.html_url), str(p.repository?.full_name))}] Repository created`;
          return telegramHtmlPayload(title);
        case "deleted":
          title = `[${escapeHtml(str(p.repository?.full_name))}] Repository deleted`;
          return telegramHtmlPayload(title);
        case "renamed":
          title = `[${htmlLinkFormatter(str(p.repository?.html_url), str(p.repository?.full_name))}] Repository renamed from ${escapeHtml(getRepoRenamedFrom(p))}`;
          return telegramHtmlPayload(title);
        default:
          // Upstream returns the zero payload for other actions (telegram.go:161).
          return goMarshalIndent({ rich_message: { html: "" } });
      }
    }
    case "wiki": {
      const info = getWikiPayloadInfo(parsed.payload, htmlLinkFormatter, true, appUrl);
      return telegramHtmlPayload(info.text);
    }
    case "release": {
      const info = getReleasePayloadInfo(parsed.payload, htmlLinkFormatter, true, appUrl);
      return telegramHtmlPayload(info.text);
    }
    case "package": {
      const info = getPackagePayloadInfo(parsed.payload, htmlLinkFormatter, true, appUrl);
      return telegramHtmlPayload(info.text);
    }
    case "status": {
      const info = getStatusPayloadInfo(parsed.payload, htmlLinkFormatter, true, appUrl);
      return telegramHtmlPayload(info.text);
    }
    case "workflow_run": {
      const info = getWorkflowRunPayloadInfo(parsed.payload, htmlLinkFormatter, true, appUrl);
      return telegramHtmlPayload(info.text);
    }
    case "workflow_job": {
      const info = getWorkflowJobPayloadInfo(parsed.payload, htmlLinkFormatter, true, appUrl);
      return telegramHtmlPayload(info.text);
    }
  }
}

// ---------------------------------------------------------------------------
// msteams.go
// ---------------------------------------------------------------------------

interface MSTeamsFact {
  name: string;
  value: string;
}

function buildMSTeamsBody(parsed: ParsedPayload, appUrl: string): string {
  let title = "";
  let text = "";
  let actionTarget = "";
  let color = 0;
  let extraFacts: Array<MSTeamsFact | null> = [];

  const set = (t: string, txt: string, target: string, c: number, facts: Array<MSTeamsFact | null> | null): void => {
    title = t;
    text = txt;
    actionTarget = target;
    color = c;
    extraFacts = facts ?? [];
  };

  switch (parsed.event) {
    case "create": {
      const p = parsed.payload;
      const refName = refShortName(str(p.ref));
      set(
        `[${str(p.repository?.full_name)}] ${str(p.ref_type)} ${refName} created`,
        "",
        `${str(p.repository?.html_url)}/src/${pathEscapeSegments(refName)}`,
        COLORS.green,
        [{ name: `${str(p.ref_type)}:`, value: refName }],
      );
      break;
    }
    case "delete": {
      const p = parsed.payload;
      const refName = refShortName(str(p.ref));
      set(
        `[${str(p.repository?.full_name)}] ${str(p.ref_type)} ${refName} deleted`,
        "",
        `${str(p.repository?.html_url)}/src/${pathEscapeSegments(refName)}`,
        COLORS.yellow,
        [{ name: `${str(p.ref_type)}:`, value: refName }],
      );
      break;
    }
    case "fork": {
      const p = parsed.payload;
      set(
        `${str(p.forkee?.full_name)} is forked to ${str(p.repository?.full_name)}`,
        "",
        str(p.repository?.html_url),
        COLORS.green,
        [{ name: "Forkee:", value: str(p.forkee?.full_name) }],
      );
      break;
    }
    case "push": {
      const p = parsed.payload;
      const branchName = refShortName(str(p.ref));
      const total = num(p.total_commits);
      const commitDesc = total === 1 ? "1 new commit" : `${total} new commits`;
      let titleLink = total === 1 ? str(nonNil(p.commits, "push.commits")[0]?.url) : str(p.compare_url);
      if (titleLink === "") {
        titleLink = `${str(p.repository?.html_url)}/src/${pathEscapeSegments(branchName)}`;
      }
      const title2 = `[${str(p.repository?.full_name)}:${branchName}] ${commitDesc}`;
      const lines: string[] = [];
      for (const commit of p.commits ?? []) {
        lines.push(`[${str(commit.id).slice(0, 7)}](${str(commit.url)}) ${trimRightNewlines(str(commit.message))} - ${str(commit.author?.name)}`);
      }
      set(title2, lines.join("\n\n"), titleLink, COLORS.green, [{ name: "Commit count:", value: String(total) }]);
      break;
    }
    case "issues": {
      const p = parsed.payload;
      const info = getIssuesPayloadInfo(p, noneLinkFormatter, false, appUrl);
      set(info.text, str(info.extraMarkdown), str(p.issue?.html_url), info.color, [
        { name: "Issue #:", value: String(num(p.issue?.id)) },
      ]);
      break;
    }
    case "issue_comment": {
      const p = parsed.payload;
      const info = getIssueCommentPayloadInfo(p, noneLinkFormatter, false, appUrl);
      set(info.text, str(p.comment?.body), str(p.comment?.html_url), info.color, [
        { name: "Issue #:", value: String(num(p.issue?.id)) },
      ]);
      break;
    }
    case "pull_request": {
      const p = parsed.payload;
      const info = getPullRequestPayloadInfo(p, noneLinkFormatter, false, appUrl);
      const facts: Array<MSTeamsFact | null> = [
        { name: "Pull request:", value: `[#${num(p.number)}](${str(p.pull_request?.html_url)})` },
      ];
      if (
        (str(p.action) === "review_requested" || str(p.action) === "review_request_removed") &&
        p.requested_reviewer != null
      ) {
        let reviewerName = str(p.requested_reviewer.login);
        if (str(p.requested_reviewer.full_name) !== "") {
          reviewerName += ` (${str(p.requested_reviewer.full_name)})`;
        }
        facts.push({ name: "Requested Reviewer:", value: reviewerName });
      }
      set(info.text, str(info.extraMarkdown), str(p.pull_request?.html_url), info.color, facts);
      break;
    }
    case "pull_request_review": {
      const p = parsed.payload;
      const action = parseHookPullRequestEventType(parsed.reviewEvent);
      if (action === null) throw new ProviderPayloadError("unknown event type");
      const reviewColor =
        parsed.reviewEvent === "pull_request_review_approved"
          ? COLORS.green
          : parsed.reviewEvent === "pull_request_review_rejected"
            ? COLORS.red
            : parsed.reviewEvent === "pull_request_review_comment"
              ? COLORS.grey
              : COLORS.yellow;
      set(
        `[${str(p.repository?.full_name)}] Pull request review ${action}: #${num(p.number)} ${str(p.pull_request?.title)}`,
        str(p.review?.content),
        str(p.pull_request?.html_url),
        reviewColor,
        [{ name: "Pull request:", value: `[#${num(p.number)}](${str(p.pull_request?.html_url)})` }],
      );
      break;
    }
    case "repository": {
      const p = parsed.payload;
      switch (str(p.action)) {
        case "created":
          set(`[${str(p.repository?.full_name)}] Repository created`, "", str(p.repository?.html_url), COLORS.green, null);
          break;
        case "deleted":
          set(`[${str(p.repository?.full_name)}] Repository deleted`, "", "", COLORS.yellow, null);
          break;
        case "renamed":
          set(
            `[${str(p.repository?.full_name)}] Repository renamed from ${getRepoRenamedFrom(p)}`,
            "",
            str(p.repository?.html_url),
            COLORS.green,
            null,
          );
          break;
      }
      break;
    }
    case "wiki": {
      const p = parsed.payload;
      const info = getWikiPayloadInfo(p, noneLinkFormatter, false, appUrl);
      set(
        info.text,
        "",
        `${str(p.repository?.html_url)}/wiki/${goPathEscapeSegment(str(p.page))}`,
        info.color,
        null,
      );
      break;
    }
    case "release": {
      const p = parsed.payload;
      const info = getReleasePayloadInfo(p, noneLinkFormatter, false, appUrl);
      set(info.text, "", str(p.release?.html_url), info.color, [{ name: "Tag:", value: str(p.release?.tag_name) }]);
      break;
    }
    case "package": {
      const p = parsed.payload;
      const info = getPackagePayloadInfo(p, noneLinkFormatter, false, appUrl);
      set(info.text, "", str(p.package?.html_url), info.color, [{ name: "Package:", value: str(p.package?.name) }]);
      break;
    }
    case "status": {
      const p = parsed.payload;
      const info = getStatusPayloadInfo(p, noneLinkFormatter, false, appUrl);
      set(info.text, "", str(p.target_url), info.color, [{ name: "CommitStatus:", value: str(p.context) }]);
      break;
    }
    case "workflow_run": {
      const p = parsed.payload;
      const info = getWorkflowRunPayloadInfo(p, noneLinkFormatter, false, appUrl);
      set(info.text, "", str(p.workflow_run?.html_url), info.color, [
        { name: "WorkflowRun:", value: str(p.workflow_run?.display_title) },
      ]);
      break;
    }
    case "workflow_job": {
      const p = parsed.payload;
      const info = getWorkflowJobPayloadInfo(p, noneLinkFormatter, false, appUrl);
      set(info.text, "", str(p.workflow_job?.html_url), info.color, [
        { name: "WorkflowJob:", value: str(p.workflow_job?.name) },
      ]);
      break;
    }
  }

  const sender = senderOf(parsed);
  const repo = repoOf(parsed);
  // createMSTeamsPayload (msteams.go:364-406): the repository fact leads,
  // nil extra facts drop, and the sender section fields are the zero values.
  const facts: MSTeamsFact[] = [];
  if (repo != null) {
    facts.push({ name: "Repository:", value: `[${str(repo.full_name)}](${str(repo.html_url)})` });
  }
  for (const fact of extraFacts) {
    if (fact !== null) facts.push(fact);
  }

  const payload = {
    "@type": "MessageCard",
    "@context": "https://schema.org/extensions",
    themeColor: colorHex(color),
    title,
    summary: title,
    sections: [
      {
        activityTitle: str(sender?.full_name),
        activitySubtitle: str(sender?.login),
        activityImage: str(sender?.avatar_url),
        facts,
        text,
      },
    ],
    potentialAction: [
      {
        "@type": "OpenUri",
        name: "View in Gitea",
        targets: [{ os: "default", uri: actionTarget }],
      },
    ],
  };
  return goMarshalIndent(payload);
}

function repoOf(parsed: ParsedPayload): { full_name?: string; html_url?: string } | null | undefined {
  switch (parsed.event) {
    case "create":
    case "delete":
      return parsed.payload.repository;
    case "fork":
      return parsed.payload.repository;
    case "issues":
    case "issue_comment":
    case "pull_request":
    case "pull_request_review":
    case "repository":
    case "release":
    case "wiki":
      return parsed.payload.repository;
    case "push":
      return parsed.payload.repository;
    case "package":
      return parsed.payload.repository;
    case "status":
    case "workflow_run":
    case "workflow_job":
      return parsed.payload.repository;
  }
}

// ---------------------------------------------------------------------------
// feishu.go
// ---------------------------------------------------------------------------

/** `feishuGenSign` (feishu.go:199-204) — HMAC-SHA256 keyed by "{ts}\n{secret}", base64. */
async function feishuGenSign(secret: string, timestamp: number): Promise<string> {
  const stringToSign = `${timestamp}\n${secret}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(stringToSign),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new Uint8Array(0));
  let binary = "";
  for (const byte of new Uint8Array(signature)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function buildFeishuBody(parsed: ParsedPayload, appUrl: string, secret: string, now: Date): Promise<string> {
  let text = "";

  const setText = (t: string): void => {
    text = t;
  };

  switch (parsed.event) {
    case "create": {
      const p = parsed.payload;
      setText(`[${str(p.repository?.full_name)}] ${str(p.ref_type)} ${refShortName(str(p.ref))} created`);
      break;
    }
    case "delete": {
      const p = parsed.payload;
      setText(`[${str(p.repository?.full_name)}] ${str(p.ref_type)} ${refShortName(str(p.ref))} deleted`);
      break;
    }
    case "fork": {
      const p = parsed.payload;
      setText(`${str(p.forkee?.full_name)} is forked to ${str(p.repository?.full_name)}`);
      break;
    }
    case "push": {
      const p = parsed.payload;
      const branchName = refShortName(str(p.ref));
      const commitDesc = num(p.total_commits) === 1 ? "1 new commit" : `${num(p.total_commits)} new commits`;
      let html = `[${str(p.repository?.full_name)}:${branchName}] ${commitDesc}\r\n`;
      const lines: string[] = [];
      for (const commit of p.commits ?? []) {
        const authorName = commit.author != null ? ` - ${str(commit.author.name)}` : "";
        lines.push(`[${str(commit.id).slice(0, 7)}](${str(commit.url)}) ${trimRightNewlines(str(commit.message))}${authorName}`);
      }
      html += lines.join("\r\n");
      setText(html);
      break;
    }
    case "issues": {
      const p = parsed.payload;
      const info = getIssuesInfo(p);
      if (info.assignees !== "") {
        if (str(p.action) === "assigned" || str(p.action) === "unassigned" || str(p.action) === "milestoned") {
          setText(`${info.title}\n${info.link}\n${info.by}\n${info.operator}\n${info.operateResult}\n${info.assignees}\n\n${str(p.issue?.body)}`);
        } else {
          setText(`${info.title}\n${info.link}\n${info.by}\n${info.operator}\n${info.assignees}\n\n${str(p.issue?.body)}`);
        }
      } else {
        setText(`${info.title}\n${info.link}\n${info.by}\n${info.operator}\n\n${str(p.issue?.body)}`);
      }
      break;
    }
    case "issue_comment": {
      const p = parsed.payload;
      const info = getIssuesCommentInfo(p);
      setText(`${info.title}\n${info.link}\n${info.by}\n${info.operator}\n\n${str(p.comment?.body)}`);
      break;
    }
    case "pull_request": {
      const p = parsed.payload;
      const info = getPullRequestInfo(p);
      if (info.assignees !== "") {
        if (str(p.action) === "assigned" || str(p.action) === "unassigned" || str(p.action) === "milestoned") {
          setText(`${info.title}\n${info.link}\n${info.by}\n${info.operator}\n${info.operateResult}\n${info.assignees}\n\n${str(p.pull_request?.body)}`);
        } else {
          setText(`${info.title}\n${info.link}\n${info.by}\n${info.operator}\n${info.assignees}\n\n${str(p.pull_request?.body)}`);
        }
      } else {
        setText(`${info.title}\n${info.link}\n${info.by}\n${info.operator}\n\n${str(p.pull_request?.body)}`);
      }
      break;
    }
    case "pull_request_review": {
      const p = parsed.payload;
      const action = parseHookPullRequestEventType(parsed.reviewEvent);
      if (action === null) throw new ProviderPayloadError("unknown event type");
      const title = `[${str(p.repository?.full_name)}] Pull request review ${action} : #${num(p.number)} ${str(p.pull_request?.title)}`;
      setText(`${title}\r\n\r\n${str(p.review?.content)}`);
      break;
    }
    case "repository": {
      const p = parsed.payload;
      switch (str(p.action)) {
        case "created":
          setText(`[${str(p.repository?.full_name)}] Repository created`);
          break;
        case "deleted":
          setText(`[${str(p.repository?.full_name)}] Repository deleted`);
          break;
        case "renamed":
          setText(`[${str(p.repository?.full_name)}] Repository renamed from ${getRepoRenamedFrom(p)}`);
          break;
      }
      break;
    }
    case "wiki": {
      const info = getWikiPayloadInfo(parsed.payload, noneLinkFormatter, true, appUrl);
      setText(info.text);
      break;
    }
    case "release": {
      const info = getReleasePayloadInfo(parsed.payload, noneLinkFormatter, true, appUrl);
      setText(info.text);
      break;
    }
    case "package": {
      const info = getPackagePayloadInfo(parsed.payload, noneLinkFormatter, true, appUrl);
      setText(info.text);
      break;
    }
    case "status": {
      const info = getStatusPayloadInfo(parsed.payload, noneLinkFormatter, true, appUrl);
      setText(info.text);
      break;
    }
    case "workflow_run": {
      const info = getWorkflowRunPayloadInfo(parsed.payload, noneLinkFormatter, true, appUrl);
      setText(info.text);
      break;
    }
    case "workflow_job": {
      const info = getWorkflowJobPayloadInfo(parsed.payload, noneLinkFormatter, true, appUrl);
      setText(info.text);
      break;
    }
  }

  const payloadText = trimSpace(text);

  // newFeishuTextPayload (:34-43) + the timestamp/sign pair (:212-217). The
  // field ORDER matters: timestamp/sign lead the struct, omitempty — absent
  // when no secret.
  let payload: Record<string, unknown>;
  if (secret !== "") {
    const timestamp = Math.floor(now.getTime() / 1000);
    payload = {
      timestamp,
      sign: await feishuGenSign(secret, timestamp),
      msg_type: "text",
      content: { text: payloadText },
    };
  } else {
    payload = {
      msg_type: "text",
      content: { text: payloadText },
    };
  }
  return goMarshalIndent(payload);
}

// ---------------------------------------------------------------------------
// matrix.go
// ---------------------------------------------------------------------------

/** `matrixPayloadSizeLimit` (matrix.go:63). */
const MATRIX_PAYLOAD_SIZE_LIMIT = 1024 * 64;

interface MatrixPayload {
  body: string;
  msgtype: string;
  format: string;
  formatted_body: string;
  "io.gitea.commits"?: unknown;
}

/** `MatrixLinkToRef` (matrix.go:295-305). */
function matrixLinkToRef(repoUrl: string, ref: string): string {
  const refName = refShortName(ref);
  if (ref.startsWith("refs/heads/")) {
    return htmlLinkFormatter(`${repoUrl}/src/branch/${pathEscapeSegments(refName)}`, refName);
  }
  if (ref.startsWith("refs/tags/")) {
    return htmlLinkFormatter(`${repoUrl}/src/tag/${pathEscapeSegments(refName)}`, refName);
  }
  return htmlLinkFormatter(`${repoUrl}/src/commit/${pathEscapeSegments(refName)}`, refName);
}

/** `getMessageBody` (matrix.go:272-276) — anchors to markdown links, <br> to \n. */
function matrixMessageBody(htmlText: string): string {
  return htmlText
    .replace(/<a [^>]*?href="([^">]*?)">(.*?)<\/a>/g, (_match, href: string, inner: string) => `[${inner}](${href})`)
    .replaceAll("<br>", "\n");
}

function matrixNewPayload(msgType: string, text: string, commits?: unknown): MatrixPayload {
  const payload: MatrixPayload = {
    body: matrixMessageBody(text),
    msgtype: msgType,
    format: "org.matrix.custom.html",
    formatted_body: text,
  };
  // io.gitea.commits is omitempty: present only for push (matrix.go:188).
  if (commits !== undefined) {
    payload["io.gitea.commits"] = commits;
  }
  return payload;
}

function buildMatrixPayload(parsed: ParsedPayload, msgType: string, appUrl: string): MatrixPayload {
  switch (parsed.event) {
    case "create": {
      const p = parsed.payload;
      const repoLink = htmlLinkFormatter(str(p.repository?.html_url), str(p.repository?.full_name));
      const refLink = matrixLinkToRef(str(p.repository?.html_url), str(p.ref));
      return matrixNewPayload(msgType, `[${repoLink}:${refLink}] ${str(p.ref_type)} created by ${str(p.sender?.login)}`);
    }
    case "delete": {
      const p = parsed.payload;
      const refName = refShortName(str(p.ref));
      const repoLink = htmlLinkFormatter(str(p.repository?.html_url), str(p.repository?.full_name));
      return matrixNewPayload(msgType, `[${repoLink}:${refName}] ${str(p.ref_type)} deleted by ${str(p.sender?.login)}`);
    }
    case "fork": {
      const p = parsed.payload;
      const baseLink = htmlLinkFormatter(str(p.forkee?.html_url), str(p.forkee?.full_name));
      const forkLink = htmlLinkFormatter(str(p.repository?.html_url), str(p.repository?.full_name));
      return matrixNewPayload(msgType, `${baseLink} is forked to ${forkLink}`);
    }
    case "push": {
      const p = parsed.payload;
      const total = num(p.total_commits);
      const commitDesc = total === 1 ? "1 commit" : `${total} commits`;
      const repoLink = htmlLinkFormatter(str(p.repository?.html_url), str(p.repository?.full_name));
      const branchLink = matrixLinkToRef(str(p.repository?.html_url), str(p.ref));
      let text = `[${repoLink}] ${str(p.pusher?.login)} pushed ${commitDesc} to ${branchLink}:<br>`;
      for (const [index, commit] of (p.commits ?? []).entries()) {
        text += `${htmlLinkFormatter(str(commit.url), str(commit.id).slice(0, 7))}: ${str(commit.message)} - ${str(commit.author?.name)}`;
        if (index < (p.commits?.length ?? 0) - 1) {
          text += "<br>";
        }
      }
      return matrixNewPayload(msgType, text, p.commits ?? []);
    }
    case "issues": {
      const info = getIssuesPayloadInfo(parsed.payload, htmlLinkFormatter, true, appUrl);
      return matrixNewPayload(msgType, info.text);
    }
    case "issue_comment": {
      const info = getIssueCommentPayloadInfo(parsed.payload, htmlLinkFormatter, true, appUrl);
      return matrixNewPayload(msgType, info.text);
    }
    case "pull_request": {
      const info = getPullRequestPayloadInfo(parsed.payload, htmlLinkFormatter, true, appUrl);
      return matrixNewPayload(msgType, info.text);
    }
    case "pull_request_review": {
      const p = parsed.payload;
      const action = parseHookPullRequestEventType(parsed.reviewEvent);
      if (action === null) throw new ProviderPayloadError("unknown event type");
      const senderLink = htmlLinkFormatter(appUrl + str(p.sender?.login), str(p.sender?.login));
      const title = `#${num(p.number)} ${str(p.pull_request?.title)}`;
      const titleLink = htmlLinkFormatter(str(p.pull_request?.html_url), title);
      const repoLink = htmlLinkFormatter(str(p.repository?.html_url), str(p.repository?.full_name));
      return matrixNewPayload(msgType, `[${repoLink}] Pull request review ${action}: ${titleLink} by ${senderLink}`);
    }
    case "repository": {
      const p = parsed.payload;
      const senderLink = htmlLinkFormatter(appUrl + str(p.sender?.login), str(p.sender?.login));
      const repoLink = htmlLinkFormatter(str(p.repository?.html_url), str(p.repository?.full_name));
      let text = "";
      switch (str(p.action)) {
        case "created":
          text = `[${repoLink}] Repository created by ${senderLink}`;
          break;
        case "deleted":
          text = `[${repoLink}] Repository deleted by ${senderLink}`;
          break;
        case "renamed":
          text = `[${repoLink}] Repository renamed from ${getRepoRenamedFrom(p)} by ${senderLink}`;
          break;
      }
      return matrixNewPayload(msgType, text);
    }
    case "wiki": {
      const info = getWikiPayloadInfo(parsed.payload, htmlLinkFormatter, true, appUrl);
      return matrixNewPayload(msgType, info.text);
    }
    case "release": {
      const info = getReleasePayloadInfo(parsed.payload, htmlLinkFormatter, true, appUrl);
      return matrixNewPayload(msgType, info.text);
    }
    case "package": {
      const p = parsed.payload;
      const senderLink = htmlLinkFormatter(appUrl + str(p.sender?.login), str(p.sender?.login));
      const packageLink = htmlLinkFormatter(str(p.package?.html_url), str(p.package?.name));
      let text = "";
      switch (str(p.action)) {
        case "created":
          text = `[${packageLink}] Package published by ${senderLink}`;
          break;
        case "deleted":
          text = `[${packageLink}] Package deleted by ${senderLink}`;
          break;
      }
      return matrixNewPayload(msgType, text);
    }
    case "status": {
      const p = parsed.payload;
      const refLink = htmlLinkFormatter(str(p.target_url), `${str(p.context)} [${shortShaLocal(str(p.sha))}]`);
      return matrixNewPayload(msgType, `Commit Status changed: ${refLink} - ${str(p.description)}`);
    }
    case "workflow_run": {
      const info = getWorkflowRunPayloadInfo(parsed.payload, htmlLinkFormatter, true, appUrl);
      return matrixNewPayload(msgType, info.text);
    }
    case "workflow_job": {
      const info = getWorkflowJobPayloadInfo(parsed.payload, htmlLinkFormatter, true, appUrl);
      return matrixNewPayload(msgType, info.text);
    }
  }
}

/** base.ShortSha — the matrix Status arm's 10-rune prefix. */
function shortShaLocal(sha: string): string {
  return truncateRunes(sha, 10);
}

/** `getMatrixTxnID` (matrix.go:279-292) — sha1-hex over the TRIMMED body. */
async function getMatrixTxnId(body: string): Promise<string> {
  const trimmed = body.trim();
  const bytes = new TextEncoder().encode(trimmed);
  if (bytes.length >= MATRIX_PAYLOAD_SIZE_LIMIT) {
    throw new ProviderRequestError(`getMatrixTxnID: payload size ${bytes.length} > ${MATRIX_PAYLOAD_SIZE_LIMIT}`);
  }
  const digest = await crypto.subtle.digest("SHA-1", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function matrixPlan(hook: ProviderHookShape, parsed: ParsedPayload, appUrl: string): Promise<ProviderRequestPlan> {
  const metaJson = parseMetaJson(hook.meta, "GetMatrixPayload meta json");
  const messageType = metaNumber(metaJson, "message_type");
  // messageTypeText (matrix.go:72-75): 1 → m.notice, 2 → m.text, else "".
  const msgType = messageType === 1 ? "m.notice" : messageType === 2 ? "m.text" : "";

  const body = goMarshalIndent(buildMatrixPayload(parsed, msgType, appUrl));
  const txnId = await getMatrixTxnId(body);
  // `fmt.Sprintf("%s/%s", w.URL, url.PathEscape(txnID))` — the hex txn has no
  // escapable bytes, the escape is a no-op (matrix.go:78).
  const url = `${hook.url}/${txnId}`;
  return {
    kind: "provider",
    method: "PUT",
    url,
    body,
    loggedBody: body,
    contentType: "application/json",
    defaultHeaders: true, // "likely useless, but has always been sent historically"
  };
}

// ---------------------------------------------------------------------------
// wechatwork.go
// ---------------------------------------------------------------------------

interface WechatworkPayload {
  msgtype: string;
  text: { content: string; mentioned_list: null; mentioned_mobile_list: null };
  markdown: { content: string };
}

function wechatworkMarkdownPayload(content: string): WechatworkPayload {
  return {
    msgtype: "markdown",
    // The Go struct's non-omitempty text block always marshals with nulls.
    text: { content: "", mentioned_list: null, mentioned_mobile_list: null },
    markdown: { content },
  };
}

function buildWechatworkBody(parsed: ParsedPayload): string {
  let payload: WechatworkPayload;

  switch (parsed.event) {
    case "create": {
      const p = parsed.payload;
      const refName = refShortName(str(p.ref));
      payload = wechatworkMarkdownPayload(`[${str(p.repository?.full_name)}] ${str(p.ref_type)} ${refName} created`);
      break;
    }
    case "delete": {
      const p = parsed.payload;
      const refName = refShortName(str(p.ref));
      payload = wechatworkMarkdownPayload(`[${str(p.repository?.full_name)}] ${str(p.ref_type)} ${refName} deleted`);
      break;
    }
    case "fork": {
      const p = parsed.payload;
      payload = wechatworkMarkdownPayload(`${str(p.forkee?.full_name)} is forked to ${str(p.repository?.full_name)}`);
      break;
    }
    case "push": {
      const p = parsed.payload;
      const branchName = refShortName(str(p.ref));
      // wechatwork.go:72-78 — commitDesc is never assigned upstream (the
      // compiler zero value, "") — the empty <font> block is upstream-true.
      const commitDesc = "";
      const title = `# ${str(p.repository?.full_name)}:${branchName} <font color="warning">  ${commitDesc}  </font>`;
      const parts: string[] = [];
      for (const commit of p.commits ?? []) {
        const authorName = commit.author != null ? `Author: ${str(commit.author.name)}` : "";
        const message = str(commit.message).replaceAll("\n\n", "\r\n");
        parts.push(` > [${str(commit.id).slice(0, 7)}](${str(commit.url)}) \r\n ><font color="info">${message}</font> \n ><font color="warning">${authorName}</font>`);
      }
      payload = wechatworkMarkdownPayload(`${title}\r\n\r\n${parts.join("\n")}`);
      break;
    }
    case "issues": {
      const p = parsed.payload;
      const info = getIssuesPayloadInfo(p, noneLinkFormatter, true, "");
      const issueUrl = str(p.issue?.html_url);
      const content = ` ><font color="info">${info.text}</font>\n >${str(info.extraMarkdown)} \n ><font color="warning"> ${str(info.issueTitle)}</font> \n [${issueUrl}](${issueUrl})`;
      payload = wechatworkMarkdownPayload(content);
      break;
    }
    case "issue_comment": {
      const p = parsed.payload;
      const info = getIssueCommentPayloadInfo(p, noneLinkFormatter, true, "");
      const commentUrl = str(p.comment?.html_url);
      const content = ` ><font color="info">${info.text}</font>\n >${str(p.comment?.body)} \n ><font color="warning">${info.issueTitle}</font> \n [${commentUrl}](${commentUrl})`;
      payload = wechatworkMarkdownPayload(content);
      break;
    }
    case "pull_request": {
      const p = parsed.payload;
      const info = getPullRequestPayloadInfo(p, noneLinkFormatter, true, "");
      const content = `> <font color="info"> ${info.text} </font> \r\n > <font color="comment">${str(info.issueTitle)} </font> \r\n > <font color="comment">${str(info.extraMarkdown)} </font> \r\n`;
      payload = wechatworkMarkdownPayload(content);
      break;
    }
    case "pull_request_review": {
      const p = parsed.payload;
      const action = parseHookPullRequestEventType(parsed.reviewEvent);
      if (action === null) throw new ProviderPayloadError("unknown event type");
      const title = `[${str(p.repository?.full_name)}] Pull request review ${action} : #${num(p.number)} ${str(p.pull_request?.title)}`;
      const text = str(p.review?.content);
      payload = wechatworkMarkdownPayload(`# ${title}\r\n\r\n >${text}`);
      break;
    }
    case "repository": {
      const p = parsed.payload;
      switch (str(p.action)) {
        case "created":
          payload = wechatworkMarkdownPayload(`[${str(p.repository?.full_name)}] Repository created`);
          break;
        case "deleted":
          payload = wechatworkMarkdownPayload(`[${str(p.repository?.full_name)}] Repository deleted`);
          break;
        case "renamed":
          payload = wechatworkMarkdownPayload(`[${str(p.repository?.full_name)}] Repository renamed from ${getRepoRenamedFrom(p)}`);
          break;
        default:
          payload = wechatworkMarkdownPayload("");
      }
      break;
    }
    case "wiki": {
      const info = getWikiPayloadInfo(parsed.payload, noneLinkFormatter, true, "");
      payload = wechatworkMarkdownPayload(info.text);
      break;
    }
    case "release": {
      const info = getReleasePayloadInfo(parsed.payload, noneLinkFormatter, true, "");
      payload = wechatworkMarkdownPayload(info.text);
      break;
    }
    case "package": {
      const info = getPackagePayloadInfo(parsed.payload, noneLinkFormatter, true, "");
      payload = wechatworkMarkdownPayload(info.text);
      break;
    }
    case "status": {
      const info = getStatusPayloadInfo(parsed.payload, noneLinkFormatter, true, "");
      payload = wechatworkMarkdownPayload(info.text);
      break;
    }
    case "workflow_run": {
      const info = getWorkflowRunPayloadInfo(parsed.payload, noneLinkFormatter, true, "");
      payload = wechatworkMarkdownPayload(info.text);
      break;
    }
    case "workflow_job": {
      const info = getWorkflowJobPayloadInfo(parsed.payload, noneLinkFormatter, true, "");
      payload = wechatworkMarkdownPayload(info.text);
      break;
    }
    default:
      payload = wechatworkMarkdownPayload("");
  }

  return goMarshalIndent(payload);
}

// ---------------------------------------------------------------------------
// packagist.go
// ---------------------------------------------------------------------------

function buildPackagistBody(parsed: ParsedPayload, meta: string): string {
  const metaJson = parseMetaJson(meta, "newpackagistRequest meta json");
  const packageUrl = metaString(metaJson, "package_url");
  // Only the push arm carries the repository URL (packagist.go:62-72); every
  // other event ships the zero payload with the always-serialized struct.
  const url = parsed.event === "push" ? packageUrl : "";
  return goMarshalIndent({ repository: { url } });
}

// (no public surface beyond planProviderRequest/hasProviderRequester and the
// ProviderRequestError class — the per-provider builders are private).
