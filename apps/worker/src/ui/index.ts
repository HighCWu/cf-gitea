/**
 * The Tier-2 UI router (SPEC-0008 §2.4 module layout): `uiRouter` +
 * `handlesUiRoute` + the route parsers (ref-suffix resolution). This module
 * is the single owner of UI route knowledge (§2.2).
 *
 * UI route inventory (§2.1 + the wave-2 extension — all GET; the slice-1
 * families render through the shell, /tree is upstream's redirect):
 *
 *   /:owner/:repo                          repo home (pages/home.tsx)
 *   /:owner/:repo/commits[/{ref-suffix}]   commit log (pages/commits.tsx)
 *   /:owner/:repo/src[/{ref-suffix}]       file view (pages/file-view.tsx;
 *                                          §3.3 requires the
 *                                          `branch|tag|commit` prefix)
 *   /:owner/:repo/tree[/{raw-suffix}]      code-tree URL family
 *                                          (pages/repo-home.tsx — upstream
 *                                          RedirectRepoTreeToSrc: 303 onto
 *                                          /src/{raw-suffix}, query kept)
 *   /:owner/:repo/issues                   issues list (pages/issues-list.tsx)
 *   /:owner/:repo/pulls                    pulls list (same component over
 *                                          is_pull rows — issues-list.tsx)
 *   /:owner/:repo/issues/{index}           issue detail (pages/issue-detail.tsx)
 *   /:owner/:repo/pulls/{index}            PR detail (same component over
 *                                          is_pull rows — issue-detail.tsx;
 *                                          upstream's type/URL match 303s the
 *                                          mismatched family onto the right
 *                                          one, issue_view.go:347-352)
 *   /:owner/:repo/issues/new               new-issue form, GET + POST
 *                                          (pages/new-issue.tsx — the first
 *                                          authed write surface; POST → the
 *                                          tier-1 IssuesService.createIssue →
 *                                          303 onto the created detail page;
 *                                          anonymous GET 303s onto
 *                                          /login?redirect_to=…)
 *   /:owner/:repo/settings                 repo basics form, GET + POST
 *                                          (pages/settings.tsx — admin
 *                                          viewer only)
 *   /:owner/:repo/settings/hooks           webhooks list + add form, GET +
 *                                          POST (pages/settings.tsx — admin
 *                                          viewer only)
 *   /:owner/:repo/{issues|pulls}/{index}/comments   comment write, POST
 *                                          (pages/issue-detail.tsx — wave 5;
 *                                          the `status` field carries the
 *                                          close/reopen toggle; success
 *                                          303s onto the canonical page
 *                                          with the #issuecomment anchor;
 *                                          anonymous 303s onto /login;
 *                                          GET → 405, upstream chi parity)
 *   /:owner/:repo/issues/labels            sidebar label write, POST
 *                                          (pages/issue-detail.tsx — wave 5;
 *                                          admin viewer only; GET → 405)
 *   /:owner/:repo/pulls/{index}/files      PR files diff view, GET
 *                                          (pages/pull-files.tsx — wave 5;
 *                                          the landed pullRequestDiff
 *                                          service)
 *   /:owner/:repo/pulls/{index}/commits    PR commits tab, GET (pages/
 *                                          pull-commits.tsx — the three-tab
 *                                          menu completion; the landed
 *                                          listCommitsRange over the PR's
 *                                          merge base and refs/pull head)
 *   /:owner/:repo/milestones               milestones list, GET (pages/
 *                                          milestones.tsx — wave 6; the
 *                                          landed listRepoMilestones read;
 *                                          `?state=` the open/closed facet)
 *   /:owner/:repo/milestones/new           new-milestone form, GET + POST
 *                                          (pages/milestones.tsx — wave 6;
 *                                          admin viewer only; POST → the
 *                                          landed milestone-create service
 *                                          → 303 back onto the list)
 *   /{org}                                 owner home — org rows: org home, GET
 *   /{user}                                owner home — user rows: user
 *                                          profile, GET (the SINGLE-SEGMENT
 *                                          family; wave 6 landed the org
 *                                          half — pages/org-home.tsx — and
 *                                          wave 7 the user half — pages/
 *                                          user-profile.tsx; one parse
 *                                          family `owner-home`, upstream's
 *                                          OwnerProfile dispatch
 *                                          routers/web/user/profile.go:37)
 *   /:owner/:repo/new/{branch}[/{dir}]     web file editor, GET + POST
 *   /:owner/:repo/edit/{branch}/{path}     (pages/file-editor.tsx — wave 8;
 *   /:owner/:repo/delete/{branch}/{path}   upstream's _new/_edit/_delete
 *                                          editor Combos under
 *                                          RepoRefByType(branch),
 *                                          web.go:1453-1461, at the brief's
 *                                          literal names; POST → the landed
 *                                          applyFileChanges with the
 *                                          session viewer as author/committer
 *                                          and the push-webhook family
 *                                          riding the delta; success 303s
 *                                          onto the file view / tree;
 *                                          anonymous GET+POST 303 onto
 *                                          /login, non-writers and archived
 *                                          repos 404-shell)
 *   /                                      site root — dashboard (signed in)
 *                                          or landing (anonymous), GET
 *                                          (pages/dashboard.tsx — wave 9;
 *                                          upstream Home,
 *                                          routers/web/home.go:26-44)
 *   /explore                               303 onto /explore/repos (wave 9)
 *   /explore/repos                         repo search page, GET
 *   /explore/users                         user search page, GET
 *                                          (pages/explore.tsx — wave 9;
 *                                          upstream web.go:549-556; the
 *                                          landed search services via
 *                                          api/services/search.ts; the
 *                                          navbar Explore item anchors the
 *                                          repos page for both viewer
 *                                          kinds)
 *   /notifications                         notifications mailbox, GET
 *                                          (pages/notifications.tsx —
 *                                          wave 10; upstream web.go:1784-
 *                                          1791's reqSignIn group —
 *                                          anonymous 303s onto /login;
 *                                          `?div-only=1` answers the bare
 *                                          #notification_div fragment the
 *                                          official bundle's live refresh
 *                                          fetches)
 *   /notifications/new                     unread-count JSON, GET (`{new:
 *                                          N}` — upstream NewAvailable,
 *                                          notification.go:433-446; the
 *                                          navbar bell's live-count hook)
 *   /notifications/status                  per-row mark read/unread/pin,
 *                                          POST (upstream
 *                                          NotificationStatusPost — the
 *                                          answer is the fresh div
 *                                          fragment the bundle morphs in;
 *                                          GET → 405)
 *   /notifications/purge                   mark-all-read, POST (upstream
 *                                          NotificationPurgePost — the
 *                                          JSONRedirect shape; GET → 405)
 *   /:owner/:repo/settings/mirror          mirror panel, GET + POST
 *                                          (pages/settings.tsx — wave 10;
 *                                          admin viewer only; the Synchronize
 *                                          Now POST enqueues the landed
 *                                          mirror-sync message)
 *   /:owner/:repo/settings/hooks/{id}      per-hook page, GET (pages/
 *                                          settings.tsx — wave 14; the edit
 *                                          form + the recent-deliveries
 *                                          list; admin viewer only)
 *   /:owner/:repo/settings/hooks/{id}[/test|/delete]
 *                                          the per-hook writes, POST (the
 *                                          edit rides the page URL —
 *                                          upstream type-prefixes it; test
 *                                          mirrors TestWebhook's literal
 *                                          tail; delete carries the id on
 *                                          the tail — upstream's shared
 *                                          /delete?id= target exists for
 *                                          the list trash buttons this UI
 *                                          does not render)
 *   /:owner/:repo/settings/branches       protected-branches rules list,
 *                                          GET (pages/branch-protection.tsx
 *                                          — wave 15; admin viewer only)
 *   /:owner/:repo/settings/branches/edit  the create/edit rule form, GET +
 *                                          POST (upstream's literal; the
 *                                          GET keyed by `?rule_name=` —
 *                                          unknown falls back to create —
 *                                          the POST by the hidden rule_id)
 *   /:owner/:repo/settings/branches/priority
 *                                          the reorder write, POST (the
 *                                          no-JS repeated-ids form of the
 *                                          landed priority op)
 *   /:owner/:repo/settings/branches/{id}/delete
 *                                          the rule delete write, POST
 *                                          (upstream's literal shape)
 *   /:owner/:repo/branches                the repo branches list, GET
 *                                          (pages/branches.tsx — wave 16;
 *                                          anonymous-capable; the DEFAULT
 *                                          badge + the SPEC-0013 §3.6
 *                                          protection badge's first
 *                                          consumer; `?q=` filter,
 *                                          `?page=` pager)
 *   /:owner/:repo/branches/delete         the branch delete write, POST
 *                                          (upstream's literal route —
 *                                          web.go:1481 DeleteBranchPost —
 *                                          re-playing the landed API
 *                                          DELETE arm + the M2 deletion
 *                                          predicate; the refusals flash
 *                                          upstream's exact texts)
 *   /{org}/labels                          org labels management, GET
 *                                          (pages/org-labels.tsx — wave 14;
 *                                          the landed org-label family's
 *                                          list over the org-teams owner
 *                                          gate; the brief's literal URL —
 *                                          upstream nests the page under
 *                                          /org/{org}/settings/labels, the
 *                                          documented divergence; claims
 *                                          the `labels` second segment
 *                                          before the repo parse, shadowing
 *                                          a repo named "labels" exactly
 *                                          like the teams literal)
 *   /{org}/labels/{new|edit|delete}        the label writes, POST (upstream's
 *                                          exact POST segments, org.NewLabel
 *                                          /UpdateLabel/DeleteLabel; GET →
 *                                          405)
 *   /:owner/:repo/commit/{sha}             commit view, GET (pages/
 *                                          commit-view.tsx — wave 18; the
 *                                          parity survey's #1 dead-end:
 *                                          upstream web.go:1739's literal
 *                                          `{sha}` route, the target of
 *                                          every ShortSha link; full oids
 *                                          resolve — the engine's
 *                                          reachable-full-oid rule — the
 *                                          7..64 prefix shapes 404-shell,
 *                                          the documented divergence)
 *   /:owner/:repo/releases                 releases list, GET (pages/
 *                                          releases.tsx — wave 20; the
 *                                          parity survey's #4, upstream
 *                                          web.go:1506 repo.Releases over
 *                                          the landed api/services/releases
 *                                          + release-assets reads; drafts
 *                                          ride the write grant)
 *   /:owner/:repo/releases/new             new-release form, GET + POST
 *                                          (pages/releases.tsx — wave 20;
 *                                          upstream web.go:1517-1518; the
 *                                          writer gate; POST → the landed
 *                                          IssuesService.createRelease +
 *                                          the `release` webhook → 303 onto
 *                                          the created detail page)
 *   /:owner/:repo/releases/latest          303 onto the latest stable
 *                                          release's detail (upstream
 *                                          web.go:1510 LatestRelease —
 *                                          Redirect(Link()))
 *   /:owner/:repo/releases/tag/{tag}       release detail, GET (pages/
 *                                          releases.tsx — wave 20; upstream
 *                                          web.go:1509 SingleRelease — the
 *                                          SAME list template over one
 *                                          row; the decoded tail keeps
 *                                          slashes, the API family's
 *                                          html_url shape re-parses)
 *   /:owner/:repo/releases/edit/{tag}      release edit form + write, GET +
 *                                          POST (pages/releases.tsx — wave
 *                                          33, the survey's top-5 #4;
 *                                          upstream web.go:1519-1520
 *                                          EditRelease/EditReleasePost —
 *                                          new.tmpl under
 *                                          PageIsEditRelease, the landed
 *                                          editRelease arm, writer-gated;
 *                                          POST 303s onto the list)
 *   /:owner/:repo/releases/delete          release delete, POST (wave 33;
 *                                          upstream web.go:1523
 *                                          DeleteRelease — the edit page's
 *                                          red button, the landed
 *                                          deleteRelease cascade + the
 *                                          `release` deleted webhook, drafts
 *                                          silent; GET → 405)
 *   /:owner/:repo/compare[/{base}...{head}]  compare view, GET + POST
 *                                          (pages/compare.tsx — wave 13;
 *                                          upstream web.go:1307-1315's
 *                                          /compare group — the bare URL and
 *                                          the FIRST-`...` split, `..` and
 *                                          fork-form heads unclaimed → the
 *                                          engine's 404; the POST is the
 *                                          new-PR write over the landed
 *                                          create arms, writer-gated, 303
 *                                          onto the created PR)
 *   /:owner/:repo/pulls/{index}/files/reviews/submit  review verdict write,
 *                                          POST (pages/pull-reviews.tsx —
 *                                          wave 11; upstream web.go:1678
 *                                          SubmitReview; success 303s onto
 *                                          the PR page's #issuecomment
 *                                          anchor; anonymous 303s onto
 *                                          /login; GET → 405)
 *   /:owner/:repo/issues/request_review     review request add/detach, POST
 *                                          (pages/pull-reviews.tsx — wave
 *                                          11; upstream web.go:1435
 *                                          UpdatePullReviewRequest; the
 *                                          issue/reviewer ids ride the
 *                                          form; GET → 405)
 *   /:owner/:repo/issues/dismiss_review     review dismiss, POST
 *                                          (pages/pull-reviews.tsx —
 *                                          wave 11; upstream web.go:1436
 *                                          DismissReview, admin only;
 *                                          GET → 405)
 *   /:org/teams                             org teams list, GET (pages/
 *                                          org-teams.tsx — wave 12;
 *                                          upstream web.go:993 org.Teams
 *                                          at the landed requireOrgOwnership
 *                                          posture — owner/site-admin
 *                                          viewers only, everyone else
 *                                          404-shells; the literal claims
 *                                          the shape before the repo parse,
 *                                          upstream's own shadowing order)
 *   /:org/teams/new                         create-team form, GET + POST
 *                                          (pages/org-teams.tsx — wave 12;
 *                                          upstream teams.go:316-390
 *                                          NewTeam/NewTeamPost at the
 *                                          owner gate; POST → the landed
 *                                          createTeam arm → 303 onto the
 *                                          created team's detail slice)
 *   /:org/teams/{id}                        team detail slice, GET (pages/
 *                                          org-teams.tsx — wave 12; the
 *                                          members + repo-access lists,
 *                                          upstream members.tmpl +
 *                                          repositories.tmpl merged; the id
 *                                          keys the landed /teams/{id} read
 *                                          arms — upstream's name links are
 *                                          the documented divergence)
 *   /user/settings                          user settings profile, GET + POST
 *                                          (pages/user-settings.tsx — wave
 *                                          12; upstream's reqSignIn
 *                                          /user/settings group at the
 *                                          settingsGate posture — anonymous
 *                                          303s onto /login; POST re-plays
 *                                          the landed PATCH route's service
 *                                          sequence → 303)
 *   /repo/create                            new-repository form, GET + POST
 *                                          (pages/repo-create.tsx — wave
 *                                          19; upstream's reqSignIn
 *                                          /repo/create group,
 *                                          web.go:1094-1098; POST → the
 *                                          landed create arms —
 *                                          createUserRepository for the
 *                                          doer, requireCanCreateOrgRepo +
 *                                          RepoService.create for an org —
 *                                          303 onto the new repo's home;
 *                                          anonymous 303s onto /login)
 *   /org/create                             new-organization form, GET +
 *                                          POST (pages/org-create.tsx —
 *                                          wave 19; upstream's reqSignIn
 *                                          /org/create group, web.go:970-
 *                                          974; POST → the landed
 *                                          OrgService.createOrg → 303 onto
 *                                          the org home)
 *   /org/{org}/members                      org members list, GET (pages/
 *                                          org-members.tsx — wave 23;
 *                                          upstream's literal web.go:965;
 *                                          anonymous-capable — the
 *                                          FindOrgMembersOpts.PublicOnly
 *                                          scope is the per-row gate; the
 *                                          landed orgListMembers read)
 *   /org/{org}/dashboard[/{team}]           org dashboard, GET (pages/
 *                                          org-dashboard.tsx — the census
 *                                          R06 row; upstream web.go:982-985
 *                                          user.Dashboard under
 *                                          OrgAssignment{RequireMember,
 *                                          RequireTeamMember} — MEMBER-ONLY,
 *                                          anonymous and non-members
 *                                          404-shell (no login redirect);
 *                                          the org feed through the landed
 *                                          activity-feeds read, the {team}
 *                                          tail filtering through the team's
 *                                          repo set; the heatmap arm is R03,
 *                                          the issues/pulls/milestones tabs
 *                                          are R07 — both unrendered)
 *   /{org}/-/repositories                   org repositories view, GET
 *                                          (pages/org-repos.tsx — wave 23;
 *                                          upstream's web.go:1134 route in
 *                                          the /{username}/- group; the
 *                                          org-home DOM through the second
 *                                          URL — tplOrgHome serves both
 *                                          upstream; user names 404-shell)
 *   /:owner/:repo/forks                    forks list, GET (pages/
 *                                          repo-social.tsx — wave 24; the
 *                                          parity survey's bench trio,
 *                                          web.go:1759; the landed
 *                                          listForks read with the reduced
 *                                          accessible-condition)
 *   /:owner/:repo/stars                    stargazers cards, GET (same
 *                                          module — web.go:1766; the
 *                                          landed listRepoStargazers read;
 *                                          upstream's tplWatchers serves
 *                                          both social pages, so this
 *                                          carries `repository watchers`)
 *   /:owner/:repo/watchers                 watchers cards, GET (same
 *                                          module — web.go:1767; the
 *                                          landed listRepoSubscribers
 *                                          read)
 *   /:owner/:repo/settings/collaboration   collaborators + teams settings
 *                                          panel, GET + POST (pages/
 *                                          settings-collaboration.tsx —
 *                                          wave 24; upstream web.go:1194's
 *                                          group; the POSTs are the add
 *                                          collaborator write plus the
 *                                          literal /access_mode, /delete,
 *                                          /team and /team/delete write
 *                                          tails over the landed
 *                                          repo-collaborators +
 *                                          TeamsService arms; admin viewer
 *                                          only — the settingsGate)
 *   /:owner/:repo/tags                     tags list page, GET (pages/tags.tsx
 *                                          — wave 25; the parity survey's
 *                                          TOP-1 row, upstream web.go:1493-
 *                                          1496's literal; the ENGINE ref
 *                                          universe (the repoListTags API's
 *                                          read) with the header menu's
 *                                          Releases/Tags pair and the per-
 *                                          tag Detail/New-Release links;
 *                                          anonymous-capable; empty repos
 *                                          404 (the group's MustBeNotEmpty);
 *                                          `?q=` filter, `?page=` pager)
 *   /:owner/:repo/tags/list                tags aux JSON, GET (pages/
 *                                          tag-list-aux.ts — wave 33, the
 *                                          survey's top-5 #2 tail; upstream
 *                                          web.go:1499 GetTagList — the
 *                                          branchTagSearchResponse shape
 *                                          {"results":[names]}, no filter,
 *                                          no query; the pin carries no
 *                                          fetching consumer, shape parity)
 *   /:owner/:repo/tags/delete              tag delete, POST (wave 33; the
 *                                          survey's top-5 #2 tail, upstream
 *                                          web.go:1501 DeleteTag — the tags
 *                                          page's per-row control,
 *                                          code-writer-gated over the
 *                                          engine ref universe + the D1
 *                                          tag-record drop, the 409
 *                                          release-attached class; GET →
 *                                          405)
 *   /:owner/:repo/labels                   labels management page, GET (pages/
 *                                          repo-labels.tsx — wave 25; the
 *                                          survey's TOP-2 row, upstream
 *                                          web.go:1338's reader group —
 *                                          anonymous-capable; the repo-label
 *                                          family's list + the upstream
 *                                          `.OrgLabels` org section)
 *   /:owner/:repo/labels/{new|edit|delete} the label writes, POST (upstream's
 *                                          exact POST segments, web.go:
 *                                          1417-1422 — repo.NewLabel/
 *                                          UpdateLabel/DeleteLabel over the
 *                                          landed repo-label arms; the
 *                                          writer gate: anonymous 303s onto
 *                                          login, archived/non-writer 404-
 *                                          shells; GET → 405;
 *                                          /labels/initialize stays
 *                                          unclaimed — no template catalog)
 *   /:owner/:repo/milestone/{id}          milestone detail, GET (pages/
 *                                          milestone-detail.tsx — wave 26;
 *                                          the survey's TOP-3 row, upstream
 *                                          web.go:1340's SINGULAR literal;
 *                                          the milestone's issues+pulls list
 *                                          with the open/closed tabs and the
 *                                          writer's Edit button; anonymous-
 *                                          capable; unknown/foreign ids 404)
 *   /:owner/:repo/milestones/{id}/edit    milestone edit form, GET + POST
 *                                          (pages/milestone-detail.tsx —
 *                                          web.go:1427-1428's writer combo;
 *                                          the labels-write gate; POST → the
 *                                          landed editRepoMilestone → 303
 *                                          onto the list; the close/open +
 *                                          delete write tails stay
 *                                          unclaimed)
 *   /:owner/:repo/fork                    fork-create form, GET + POST
 *                                          (pages/repo-fork.tsx — wave 26;
 *                                          the survey's TOP-5 row, upstream
 *                                          web.go:1490's combo; the owner
 *                                          select over the doer + the
 *                                          can-create orgs, POST → the
 *                                          landed createFork sequence →
 *                                          303 onto the fork's home;
 *                                          anonymous 303s onto /login, an
 *                                          empty source 404s)
 *   /:owner/:repo/commit/{sha}.{diff|patch}
 *   /:owner/:repo/pulls/{index}.{diff|patch}
 *                                          the diffpatch file downloads,
 *                                          GET (pages/diffpatch-files.ts —
 *                                          wave 29; the survey's row 4,
 *                                          upstream web.go:1760 repo.RawDiff
 *                                          + web.go:1657-1658
 *                                          DownloadPullDiff/Patch — raw
 *                                          text, not pages: the plain
 *                                          unified diff or the git-am mail
 *                                          shape over the landed
 *                                          renderUnifiedDiff/renderPatch +
 *                                          engineReads.readDiff /
 *                                          pullRequestDiff; short-sha
 *                                          prefixes 404 per the engine's
 *                                          full-oid rule, the commit-view
 *                                          divergence)
 *   /:owner/:repo/archive[/*]              the archive download, GET
 *                                          (pages/archive-files.ts — wave
 *                                          32; the survey's row 1, upstream
 *                                          web.go:1689 repo.Download over
 *                                          services/repository/archiver —
 *                                          the {ref}.{zip|tar.gz} tail
 *                                          streams the landed
 *                                          api/services/archive.ts builder;
 *                                          octet-stream + nosniff, the
 *                                          weak ETag/304 pair, the Nix
 *                                          immutable Link header; unknown
 *                                          suffix and the bundle refusal
 *                                          answer upstream's 400 class, the
 *                                          bare `/archive` tail included;
 *                                          the POST half —
 *                                          InitiateDownload, web.go:1690 —
 *                                          stays engine-owned)
 *   /:owner/:repo/commit/{sha}/load-branches-and-tags
 *                                          the commit view's aux JSON, GET
 *                                          (pages/commit-contained-refs.ts —
 *                                          wave 32; the survey's row 3,
 *                                          upstream web.go:1740
 *                                          repo.LoadBranchesAndTags — the
 *                                          ContainedLinks shape
 *                                          {branches,tags,default_branch}
 *                                          with per-ref {name,web_link}
 *                                          over the engine's listRefs +
 *                                          mergeBase containment walk (the
 *                                          module doc carries the cost
 *                                          posture); short/unresolvable
 *                                          shas 404 — upstream's
 *                                          ServerError 500 divergence)
 *   /:owner/:repo/blob[/*]                 the pasted-blob-URL redirect, GET
 *                                          (pages/repo-home.tsx's
 *                                          blobRedirectResponse — wave 39;
 *                                          the survey's row 1, upstream
 *                                          web.go:1757
 *                                          repo.RedirectRepoBlobToCommit —
 *                                          the tree-redirect twin: the RAW
 *                                          suffix swaps verbatim onto
 *                                          `/src/commit/`, query preserved,
 *                                          303 See Other; the bare `/blob`
 *                                          has no upstream route → the
 *                                          §4.5 404 shell)
 *   /:owner/:repo/tree-list/{branch|tag|commit}/*
 *                                          the find-file dialog's aux JSON,
 *                                          GET (pages/tree-list-aux.ts —
 *                                          wave 39; the survey's row 5,
 *                                          upstream web.go:1297-1306
 *                                          repo.TreeList — the bare
 *                                          recursive file-path array over a
 *                                          batched listTree BFS walk, the
 *                                          natural-sort port; the typed
 *                                          ref-tail resolution rides the
 *                                          landed resolveRefSuffix)
 *   /:owner/:repo/tree-view/{branch|tag|commit}/*
 *                                          the code-tree envelope aux JSON,
 *                                          GET (pages/tree-view-aux.ts —
 *                                          wave 43; the survey's row 5
 *                                          PARTIAL row's gated half,
 *                                          upstream web.go:1302-1306
 *                                          repo.TreeViewNodes — the
 *                                          {fileTreeNodes, renderedIconPool}
 *                                          envelope over the landed fileicon
 *                                          layer, the Go-escape wire bytes;
 *                                          the tail's path half roots the
 *                                          listing, ?sub_path= names the
 *                                          expansion chain)
 *   /:owner/:repo/branches/list            the branches aux JSON, GET
 *                                          (pages/branches-list-aux.ts —
 *                                          wave 39; the survey's row 5,
 *                                          upstream web.go:1695
 *                                          repo.GetBranchesList — the
 *                                          {results:[names]} feed, default
 *                                          branch hoisted, the tag-list-aux
 *                                          twin)
 *   /:owner/:repo/blob_excerpt/{sha}       the PR-diff hunk-window expansion
 *                                          fragment, GET (pages/repo-blob
 *                                          -excerpt-fragment.tsx — wave 46,
 *                                          the machinery's stage 3; upstream
 *                                          web.go:1735 repo.ExcerptBlob —
 *                                          the tplBlobExcerpt `<tr>` rows
 *                                          over BuildBlobExcerptDiffSection,
 *                                          the RenderBlobExcerptButtons
 *                                          round-trip; the wiki twin below)
 *   /:owner/:repo/wiki/blob_excerpt/{sha}  the excerpt's wiki-cell twin, GET
 *                                          (web.go:1618 — the same builder
 *                                          over the sibling `slug.wiki`
 *                                          engine cell, the hasWiki gate,
 *                                          BaseLink swapped)
 *   /:owner/:repo/lastcommit/*             the file-list commit-info refresh
 *                                          fragment, GET (pages/repo-lastcommit
 *                                          -fragment.tsx — wave 46 mounts
 *                                          the machinery wave's handoff;
 *                                          upstream web.go:1761
 *                                          repo.LastCommit — the
 *                                          tplRepoViewList standalone
 *                                          fragment the view_list loader
 *                                          fetches)
 *   /:owner/:repo/releases/attachments/{uuid}
 *   /:owner/:repo/releases/download/{vTag}/{fileName}
 *                                          the releases download tail, GET
 *                                          (pages/release-downloads.ts —
 *                                          wave 41; the survey's top-5 #1,
 *                                          upstream web.go:1513
 *                                          repo.GetAttachment + web.go:1514
 *                                          repo.RedirectDownload — the
 *                                          streamed asset serve over the
 *                                          landed release-assets data, the
 *                                          ServeAttachment header matrix +
 *                                          the `latest` alias; the module
 *                                          doc carries the ledger)
 *   /:owner/:repo/render/{branch|tag|commit}/*
 *   /:owner/:repo/render/blob/{sha}        the rendered blob views, GET
 *                                          (pages/render-files.ts — wave
 *                                          41; the survey's row 3,
 *                                          upstream web.go:1715-1719's
 *                                          /render group — standalone-page
 *                                          renders over the landed
 *                                          markdown pipeline, the
 *                                          "Unable to find renderer" 400
 *                                          class elsewhere; the module doc
 *                                          carries the divergences)
 *   /{org}/settings[/{avatar|rename|delete|visibility|avatar/delete}]
 *                                          the org settings page + its
 *                                          write arms, GET + POST on the
 *                                          bare URL, POST elsewhere
 *                                          (pages/org-settings.tsx — wave
 *                                          49; the survey's re-ranked #1,
 *                                          upstream web.go:1017-1092's
 *                                          require-owner /{org} group over
 *                                          org/settings/options.tmpl — the
 *                                          landed orgEdit/renameOrg/
 *                                          orgDelete/avatar ops; the
 *                                          applications/labels/packages/
 *                                          actions/blocked_users/audit_logs
 *                                          TABS are separate pages this
 *                                          wave does not claim; the
 *                                          `settings` literal shadows a
 *                                          repository so named exactly
 *                                          like upstream's group order)
 *   /{org}/settings/hooks                  the org webhooks list + add form,
 *                                          GET + POST
 *   /{org}/settings/hooks/{id}             the org per-hook page, GET + POST
 *   /{org}/settings/hooks/{id}/delete      the org hook delete, POST
 *                                          (pages/org-settings-hooks.tsx —
 *                                          wave 53; upstream web.go:1033-1044's
 *                                          /hooks group over org/settings/
 *                                          {hooks,hook_new}.tmpl — the
 *                                          landed owner-scoped hook arms
 *                                          (listOwnerHooks/createOwnerHook/
 *                                          getOwnerHook/deleteOwnerHook +
 *                                          the scope-agnostic editRepoHook,
 *                                          routes/hooks-scopes.ts's org
 *                                          family); no test/replay arms —
 *                                          the module header's reductions;
 *                                          the same require-owner posture)
 *   /{org}/teams/{id}/edit                 the team edit form, GET + POST
 *   /{org}/teams/{id}/delete               the team delete, POST
 *                                          (same module — web.go:1011-1013
 *                                          over the landed orgEditTeam/
 *                                          orgDeleteTeam arms; the entry
 *                                          link is the team detail
 *                                          sidebar's Settings button)
 *
 * The wave-2 families dispatch INSIDE this router (uiPage); render.tsx's
 * page switch stays the slice-1 three — which is why they parse into the
 * separate TreeRoute/IssuesListRoute/IssueDetailRoute types below instead of
 * new UiFamily members. The wave-4 write families (issue-new/settings/
 * settings-hooks) dispatch here too, with their own GET+POST handlers.
 * The rest of the suffixed /issues//pulls space (`/issues/{index}/comments`,
 * non-numeric or deeper tails), the rest of the deeper /settings/* space
 * (wave 15 claimed `/settings/branches` + its `/edit`, `/priority` and
 * `/{id}/delete` writes — pages/branch-protection.tsx; keys/tags/LFS and
 * friends stay engine-owned), and every other repo-scoped path stay with the
 * engine — the four git-protocol routes, the LFS family, and the engine
 * JSON API/admin surface. The parser claims families by shape and never
 * protocol or engine paths, and the reserved owner names (`api`, `assets` —
 * SPEC-0003 §3) are refused outright, so `/api/v1` and the edge-served
 * `/assets/*` tree are out of reach by construction.
 *
 * ## Dispatcher integration (orchestrator-owned `src/index.ts`, §2.2)
 *
 * Branch order: api → ui (`handlesUiRoute`) → gitHttpGate → engine. Exact
 * insertion:
 *
 * ```ts
 * import { uiRouter, handlesUiRoute } from "./ui";
 *
 * const app = new Hono<{ Bindings: Env }>();
 * // ... the existing /healthz + /api/v1 registrations stay first ...
 * app.route("/", uiRouter); // uiRouter claims only handlesUiRoute families
 *
 * // inside `fetch`, replacing the current unconditional repo-scoped branch
 * // (`segments[0] !== "api"` already keeps /api/v1 in Hono-land):
 * if (isRepoScoped) {
 *   // UI page families — src/ui is the single source of truth:
 *   if (handlesUiRoute(pathname)) return app.fetch(req, env, ctx);
 *   // git-protocol routes + engine passthrough: unchanged.
 *   return gitHttpGate(req, env, ctx, gitHttp);
 * }
 * return app.fetch(req, env, ctx);
 * ```
 *
 * `handlesUiRoute` is consulted BEFORE Hono is asked to route (§2.2), so the
 * sub-app only ever sees families it claims and its miss path can never
 * swallow an engine route.
 *
 * U3 note: the three pages render for real (home / commits / src, wired in
 * render.tsx's page switch). Every claimed route answers from the same
 * pipeline: parse → public-repo read (§2.5) → page data via direct service
 * calls (§3.2) → shell render; anything unresolved 404-shells. The parsers
 * below (`parseUiRoute`, `splitRefSuffix`, `resolveRefSuffix`) are the
 * pages' URL contract and ship with their semantics tests.
 */

import { Hono, type Context } from "hono";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { trimTrailingSlash } from "hono/trailing-slash";

import { isReservedOwnerName } from "../repos/service";
import { users } from "../db/schema";
import type { RunRow } from "../services/actions/model";
import { engineClient } from "./engine";
import { readUrlEncodedForm } from "./forms";
import { AssetBuildError, assetURI, loadManifest } from "./manifest";
import { renderServerErrorShellResponse } from "./not-found-response";
import { parsePageNumber, pathEscapeSegments } from "./page-data";
import { resolveRepositoryForViewer } from "./repo-view";
import { renderNotFound, renderUiPage } from "./render";
import { sameOriginGuard } from "./session";
import { blobRedirectResponse, isFetchActionRequest, treeRedirectResponse } from "./pages/repo-home";
import {
  loadReleaseDownload,
  openReleaseAttachment,
  releaseAttachmentResponse,
  type ReleaseAttachmentServe,
} from "./pages/release-downloads";
import { loadRenderFile, renderFileResponse, renderNotAvailableResponse, type RenderFileTarget } from "./pages/render-files";
import { loadMediaBlob, loadRawBlob, mediaBlobResponse, rawBlobResponse, type RawMediaTarget } from "./pages/raw-files";
import {
  canWriteRepo,
  commitFileFromForm,
  editorFormFromData,
  loadFileEditorData,
  readEditorForm,
  renderFileEditorPage,
} from "./pages/file-editor";
import {
  loadRepoActionsRunsData,
  parseActionRunQuery,
  renderRepoActionsRunsFragment,
  renderRepoActionsRunsPage,
} from "./pages/repo-actions-runs";
import {
  loadJobQueuePageData,
  renderAdminActionsJobQueuePage,
  renderJobQueueFragment,
  renderRepoActionsJobQueuePage,
} from "./pages/repo-actions-queue";
import {
  buildViewResponse,
  cancelActionRun,
  loadRepoActionsViewPageData,
  parsePathParamInt64,
  readViewRequest,
  renderRepoActionsViewPage,
  resolveRunAttemptAndJobs,
  resolveRunByPath,
  resolveRunForView,
} from "./pages/repo-actions-view";
import {
  loadArtifactPreviewPageData,
  renderArtifactPreviewPage,
  serveArtifactPreviewRaw,
} from "./pages/repo-actions-artifacts";
import { buildRunArtifactDownload, deleteRunArtifact } from "./pages/repo-actions-artifacts-download";
import { actionsJobLogsResponse, loadActionsRunJobLogs } from "./pages/repo-actions-logs";
import { resolveActionsRunWorkflowFile } from "./pages/repo-actions-workflow";
import { renderWorkflowBadgeSvg, resolveWorkflowBadge } from "./pages/repo-actions-badge";
import { loadWorkflowDispatchInputsFragment } from "./pages/repo-actions-dispatch-inputs";
import {
  bulkAdminActionsRunners,
  deleteAdminActionsRunner,
  loadAdminActionsRunnerEditPageData,
  loadAdminActionsRunnersPageData,
  parseAdminActionsRunnerBulkForm,
  parseAdminActionsRunnerDescriptionForm,
  parseAdminActionsRunnerDisabledForm,
  renderAdminActionsRunnerEditPage,
  renderAdminActionsRunnersPage,
  resetAdminActionsRunnerToken,
  setAdminActionsRunnerDisabled,
  updateAdminActionsRunnerDescription,
} from "./pages/admin-actions-runners";
import {
  applyAdminActionsVariableCreate,
  applyAdminActionsVariableUpdate,
  deleteAdminActionsVariable,
  loadAdminActionsVariablesPageData,
  parseAdminActionsVariableForm,
  renderAdminActionsVariablesPage,
} from "./pages/admin-actions-variables";
import {
  deleteRepoActionsRunner,
  loadRepoActionsRunnerEditPageData,
  loadRepoActionsRunnersPageData,
  parseRepoActionsRunnerDescriptionForm,
  parseRepoActionsRunnerDisabledForm,
  renderRepoActionsRunnerEditPage,
  renderRepoActionsRunnersPage,
  resetRepoActionsRunnerToken,
  setRepoActionsRunnerDisabled,
  updateRepoActionsRunnerDescription,
} from "./pages/repo-settings-actions-runners";
import {
  applyRepoActionsUnitToggle,
  loadRepoActionsGeneralPageData,
  parseRepoActionsUnitForm,
  REPO_ACTIONS_GENERAL_REDIRECT_TARGET,
  renderRepoActionsGeneralPage,
} from "./pages/repo-settings-actions-general";
import {
  applyIssueLabels,
  createCommentFromForm,
  crossFamilyRedirect,
  loadIssueDetailData,
  parseCommentForm,
  parseIssueLabelForm,
  renderIssueDetailPage,
  resolveIssueDetailAccess,
} from "./pages/issue-detail";
import {
  changeReviewRequestFromForm,
  dismissReviewFromForm,
  parseDismissReviewForm,
  parseReviewRequestForm,
  parseReviewSubmitForm,
  PullReviewError,
  pullReviewErrorMessage,
  submitReviewFromForm,
} from "./pages/pull-reviews";
import {
  countUnreadNotifications,
  loadNotificationsData,
  isOwnMailboxThread,
  markNotificationThread,
  markThread,
  parseFormBool,
  parseNotificationPageType,
  parseNotificationStatusForm,
  purgeNotifications,
  renderNotificationDiv,
  renderNotificationsPage,
} from "./pages/notifications";
import { loadIssuesListData, renderIssuesListPage } from "./pages/issues-list";
import {
  createMilestoneFromForm,
  loadMilestonesData,
  milestonesLocale,
  parseMilestoneForm,
  renderMilestonesPage,
  renderNewMilestonePage,
} from "./pages/milestones";
import { loadOrgHomeData, renderOrgHomePage, resolveOrgHome } from "./pages/org-home";
// The census R06 org dashboard (web.go:982-985's /org/{org}/dashboard
// family) — the member-only page over the landed org-feed reads.
import {
  isOrgDashboardMember,
  isOrgDashboardTeamMember,
  loadOrgDashboardData,
  renderOrgDashboardPage,
  resolveDashboardTeam,
  resolveOrgDashboardOrg,
} from "./pages/org-dashboard";
import {
  canManageOrgTeams,
  createTeamFromForm,
  loadOrgTeamDetailData,
  loadOrgTeamDetailDataByName,
  loadOrgTeamsData,
  parseTeamNewForm,
  renderOrgTeamDetailPage,
  renderOrgTeamNewPage,
  renderOrgTeamsPage,
  resolveOrgTeamsOrg,
} from "./pages/org-teams";
import type { TeamRecord } from "../api/routes/org-teams";
import {
  createOrgLabelFromForm,
  deleteOrgLabelFromForm,
  editOrgLabelFromForm,
  formLabelId,
  loadOrgLabelsData,
  NEW_LABEL_DEFAULT_COLOR,
  parseOrgLabelForm,
  renderOrgLabelsPage,
} from "./pages/org-labels";
import {
  applyOrgDeleteForm,
  applyOrgRenameForm,
  applyOrgSettingsForm,
  applyOrgTeamDelete,
  applyOrgTeamEditForm,
  applyOrgVisibilityForm,
  deleteOrgAvatar,
  loadOrgTeamEditData,
  parseOrgDeleteForm,
  parseOrgRenameForm,
  parseOrgSettingsForm,
  parseOrgTeamEditForm,
  parseOrgVisibilityForm,
  readOrgAvatarUpload,
  renderOrgSettingsPage,
  renderOrgTeamEditPage,
  storeOrgAvatar,
  teamEditFormFromTeam,
} from "./pages/org-settings";
// Wave-53 org settings hooks tab (the org-settings module's named next
// slice — the landed owner-scoped hook arms under the /settings subtree).
import {
  createOrgHookFromForm,
  deleteOrgHook,
  loadOrgHookDetailData,
  loadOrgHooksSettings,
  renderOrgHookDetailPage,
  renderOrgHooksSettingsPage,
} from "./pages/org-settings-hooks";
// Window-2b: the org blocked-users tab + the actions secrets/variables
// sub-tabs (two-stage waves 55/59, mounted by this window).
import {
  applyOrgBlockedForm,
  loadOrgBlockedUsers,
  parseOrgBlockedForm,
  renderOrgBlockedUsersPage,
} from "./pages/org-settings-blocked";
import {
  applyOrgActionsSecretForm,
  applyOrgActionsVariableCreate,
  applyOrgActionsVariableUpdate,
  deleteOrgActionsSecret,
  deleteOrgActionsVariable,
  loadOrgActionsSecretsPageData,
  loadOrgActionsVariablesPageData,
  parseOrgActionsSecretDeleteForm,
  parseOrgActionsSecretForm,
  parseOrgActionsVariableForm,
  renderOrgActionsSecretsPage,
  renderOrgActionsVariablesPage,
} from "./pages/org-settings-actions";
// The census C7 arm's ORG scope: the org settings Actions RUNNERS sub-tab
// (the repo twin's module-level ports reused where scope-neutral; this
// module's org cond/find/writes over the M1a runner/token store).
import {
  deleteOrgActionsRunner,
  loadOrgActionsRunnerEditPageData,
  loadOrgActionsRunnersPageData,
  parseOrgActionsRunnerDescriptionForm,
  parseOrgActionsRunnerDisabledForm,
  renderOrgActionsRunnerEditPage,
  renderOrgActionsRunnersPage,
  resetOrgActionsRunnerToken,
  setOrgActionsRunnerDisabled,
  updateOrgActionsRunnerDescription,
} from "./pages/org-settings-actions-runners";
// The census R20 (a) arm: the org settings applications tab (org-OWNED
// oauth2 applications — the landed service's uid-parameterized arms keyed
// on the org's id).
import {
  applyOrgApplicationCreate,
  deleteOrgApplication,
  loadOrgSettingsApplications,
  parseOrgApplicationCreateForm,
  renderOrgApplicationsPage,
} from "./pages/org-settings-applications";
// The census R13 arm: the settings audit log pages (ONE shared module —
// upstream routers/web/shared/audit — with the repo and the org mounts; the
// scope pairs key the M4 instrumentation's encodings).
import {
  loadSettingsAuditLogs,
  renderOrgSettingsAuditLogsPage,
  renderRepoSettingsAuditLogsPage,
} from "./pages/settings-audit-logs";
import {
  applyUserProfileForm,
  loadUserSettingsPageData,
  parseUserProfileForm,
  renderUserSettingsPage,
} from "./pages/user-settings";
// Window-2a: the user-settings tab modules (two-stage waves 54-58, mounted
// by this window — each module's header carries its route recipe).
import {
  applyUserSettingsAppearanceLanguageForm,
  applyUserSettingsAppearanceThemeForm,
  loadUserSettingsAppearancePageData,
  parseUserSettingsAppearanceLanguageForm,
  parseUserSettingsAppearanceThemeForm,
  renderUserSettingsAppearancePage,
} from "./pages/user-settings-appearance";
import {
  loadUserSettingsSecurityPageData,
  renderUserSettingsSecurityPage,
} from "./pages/user-settings-security";
import {
  applyUserSettingsSecretForm,
  deleteUserSettingsSecret,
  loadUserSettingsSecretsPageData,
  parseUserSettingsSecretDeleteForm,
  parseUserSettingsSecretForm,
  renderUserSettingsSecretsPage,
} from "./pages/user-settings-secrets";
import {
  applyUserSettingsVariableCreate,
  applyUserSettingsVariableUpdate,
  deleteUserSettingsVariable,
  loadUserSettingsVariablesPageData,
  parseUserSettingsVariableForm,
  renderUserSettingsVariablesPage,
} from "./pages/user-settings-variables";
import {
  createUserHookFromForm,
  deleteUserHook,
  editUserHookFromForm,
  loadUserHookDetailData,
  loadUserSettingsHooksPageData,
  renderUserHookDetailPage,
  renderUserSettingsHooksPage,
} from "./pages/user-settings-webhooks";
import {
  addGpgKeyFromForm,
  addSshKeyFromForm,
  deleteGpgKey,
  deleteSshKey,
  loadUserSettingsKeysOwner,
  loadUserSettingsKeysPageData,
  parseUserSettingsKeysDeleteForm,
  parseUserSettingsKeysForm,
  renderUserSettingsKeysPage,
} from "./pages/user-settings-keys";
import {
  createTokenFromForm,
  loadUserSettingsApplicationsPageData,
  parseUserSettingsApplicationsDeleteForm,
  parseUserSettingsApplicationsForm,
  renderUserSettingsApplicationsPage,
  revokeTokenFromForm,
} from "./pages/user-settings-applications";
import {
  applyUserSettingsAccountDeleteForm,
  applyUserSettingsAccountEmailForm,
  deleteUserSettingsAccountEmail,
  loadUserSettingsAccountPageData,
  parseUserSettingsAccountDeleteForm,
  parseUserSettingsAccountEmailDeleteForm,
  parseUserSettingsAccountEmailForm,
  renderUserSettingsAccountPage,
} from "./pages/user-settings-account";
import {
  applyUserSettingsNotificationsActionsForm,
  applyUserSettingsNotificationsEmailForm,
  loadUserSettingsNotificationsPageData,
  parseUserSettingsNotificationsActionsForm,
  parseUserSettingsNotificationsEmailForm,
  renderUserSettingsNotificationsPage,
} from "./pages/user-settings-notifications";
import {
  loadUserSettingsReposPageData,
  renderUserSettingsReposPage,
} from "./pages/user-settings-repos";
import {
  applyUserOrgsLeave,
  loadUserOrgsSettings,
  parseUserOrgsLeaveForm,
  renderUserOrgsSettingsPage,
} from "./pages/user-settings-organizations";
// Window-2c: the admin pages (two-stage waves 61/64, mounted by this
// window — /-/admin group, web.go:779-813).
import {
  applyAdminDashboardForm,
  loadAdminDashboardData,
  parseAdminDashboardForm,
  renderAdminDashboardPage,
} from "./pages/admin-dashboard";
import {
  applyAdminMonitorCronForm,
  loadAdminMonitorCron,
  loadAdminMonitorQueues,
  loadAdminMonitorStats,
  parseAdminMonitorCronForm,
  renderAdminMonitorCronPage,
  renderAdminMonitorQueuePage,
  renderAdminMonitorStatsPage,
  renderAdminMonitorTracePage,
} from "./pages/admin-monitor";
import type { AdminMonitorPage } from "./pages/admin-monitor";
// The admin listing pages (the family prologue is shared adminPagePrologue).
import { loadAdminUsersData, renderAdminUsersPage } from "./pages/admin-users";
import { loadAdminOrgsData, renderAdminOrgsPage } from "./pages/admin-orgs";
import { loadAdminReposData, renderAdminReposPage } from "./pages/admin-repos";
// The tick-18 packages arm (pages/admin-packages.tsx — upstream
// /-/admin/packages, web.go:852-858's /packages group GET).
import { loadAdminPackagesData, renderAdminPackagesPage } from "./pages/admin-packages";
// The census R18 (a) arms (each module's header carries its mount record):
// the emails list + the activate/delete writes, the hooks two-list + delete,
// the badge-catalog family (all seven upstream routes), and the global
// oauth2 applications (list + create + delete over the landed service).
import {
  applyAdminEmailActivate,
  applyAdminEmailDelete,
  adminEmailActivateFormValid,
  loadAdminEmailsData,
  parseAdminEmailActivateForm,
  parseAdminEmailDeleteForm,
  parseAdminEmailsListParams,
  renderAdminEmailsPage,
} from "./pages/admin-emails";
import { applyAdminHookDelete, loadAdminHooksData, renderAdminHooksPage } from "./pages/admin-hooks";
import {
  addBadgeUserByName,
  adminBadgesLocale,
  createBadgeFromForm,
  deleteBadgeBySlug,
  getBadgeBySlug,
  getBadgeUsersPage,
  loadAdminBadgesData,
  parseAdminBadgeForm,
  removeBadgeUser,
  renderAdminBadgeEditPage,
  renderAdminBadgeNewPage,
  renderAdminBadgeUsersPage,
  renderAdminBadgeViewPage,
  renderAdminBadgesPage,
  updateBadgeFromForm,
  type AdminBadgeEditData,
  type AdminBadgeUsersData,
} from "./pages/admin-badges";
import {
  applyAdminApplicationCreate,
  applyAdminApplicationDelete,
  loadAdminApplicationsData,
  parseAdminApplicationCreateForm,
  renderAdminApplicationsPage,
} from "./pages/admin-applications";
import { adminNoticesLocale, loadAdminNoticesData, renderAdminNoticesPage } from "./pages/admin-notices";
// The SPEC-0018 §3.2 config arm (the census R18/R20 config summary — the
// read-only build-posture page; the vars slice keeps secrets unreachable
// even by accident, the module header's rule-3 guarantee).
import {
  adminConfigVarsFromEnv,
  loadAdminConfigData,
  renderAdminConfigPage,
} from "./pages/admin-config";
import {
  loadUserProfileData,
  renderUserProfilePage,
  resolveUserProfile,
  type ProfileDoer,
} from "./pages/user-profile";
// The profile's sub-tab pages (the ownerHomePage ?tab= dispatch — the
// activity-feeds precedent; each loader takes the doer, not the viewer).
import { loadUserFollowTabsData, renderUserFollowTabsPage } from "./pages/user-follow-tabs";
import { loadUserStarsTabData, renderUserStarsTabPage } from "./pages/user-stars-tab";
import { loadUserWatchingTabData, renderUserWatchingTabPage } from "./pages/user-watching-tab";
// Wave-19 creation pages (the authoring front door — the survey's #2).
import {
  createRepoFromForm,
  loadRepoCreateData,
  parseRepoCreateForm,
  renderRepoCreatePage,
} from "./pages/repo-create";
import {
  createOrgFromForm,
  parseOrgCreateForm,
  renderOrgCreatePage,
} from "./pages/org-create";
// Wave-23 org families (the parity survey's next tier — the members page and
// the /-/repositories repositories family).
import {
  isOrgOwnerViewer,
  loadOrgMembersData,
  renderOrgMembersPage,
  resolveOrgMembersOrg,
} from "./pages/org-members";
import {
  loadOrgRepositoriesData,
  renderOrgRepositoriesPage,
  resolveOrgRepositories,
} from "./pages/org-repos";
// Wave-37 owner projects list family (the parity survey's regenerated
// top-5 row 5 — the `/-` namespace's projects listing over the landed
// projects service).
import {
  loadOwnerProjectsData,
  renderOwnerProjectsPage,
  resolveOwnerProjects,
} from "./pages/owner-projects";
// The SPEC-0016 M2 packages families (pages/packages.tsx — the R04 owner
// subtree + the R16 repo tab over the LANDED packages model service; the
// owner-projects pattern's loaders + renderers + the resolution seam).
import {
  loadOwnerPackageVersionViewData,
  loadOwnerPackageVersionsData,
  loadOwnerPackagesData,
  loadPackageFileDownload,
  loadRepoPackagesData,
  packageFileDownloadResponse,
  renderOwnerPackageVersionViewPage,
  renderOwnerPackageVersionsPage,
  renderOwnerPackagesPage,
  renderRepoPackagesPage,
  resolveLatestVersionRedirect,
  resolvePackagesOwner,
  type PackagesOwner,
} from "./pages/packages";
// The SPEC-0016 M2 quota/env config (the profile tab's strict-polarity
// global — resolveUiSession arms `ctx.packagesEnabled` from it, and the R04
// prologue 404-shells the subtree when the feature is off).
import { getVersionByNameAndVersion, packagesQuotaFromEnv } from "../services/packages/model";
// The codesearch-M1 owner code-search family (pages/user-code-search.tsx —
// the `/-` namespace's code tail over the federation seeds; the packages
// family's owner-resolution twin without the package-access gate).
import {
  loadUserCodeSearchData,
  renderUserCodeSearchPage,
  resolveUserCodeSearchOwner,
} from "./pages/user-code-search";
// Wave-40 owner projects BOARD families (the survey's follow-up row — the
// board view + write group + workflow tails over the landed service
// predicates).
import {
  boardDoer,
  createColumnFromForm,
  createProjectFromForm,
  createWorkflowFromForm,
  deleteWorkflowFromForm,
  findOwnerProject,
  loadProjectBoardData,
  loadProjectChromeCounts,
  loadProjectWorkflowsData,
  ownerProjectWriteAccess,
  parseColumnForm,
  parseProjectForm,
  parseWorkflowForm,
  projectLinkOf,
  renderEditProjectPage,
  renderNewProjectPage,
  renderProjectBoardPage,
  renderProjectWorkflowsPage,
  setProjectDefaultColumnFromForm,
  updateProjectFromForm,
  updateWorkflowFromForm,
  type ResolvedOwner,
  type WorkflowForm,
  WORKFLOW_EVENTS,
} from "./pages/owner-project-board";
// Wave-45 repo projects surface (the parity survey's re-ranked #1 — the
// repo scope over the landed projects family; the owner-board precedent's
// owner-agnostic shapes imported, the owner-bound ones adapted beside the
// repo resolution + the has_projects unit toggle).
import {
  createRepoProjectFromForm,
  createRepoWorkflowFromForm,
  loadRepoProjectBoardData,
  loadRepoProjectWorkflowsData,
  loadRepoProjectsData,
  repoProjectLink,
  renderRepoProjectBoardPage,
  renderRepoProjectEditPage,
  renderRepoProjectNewPage,
  renderRepoProjectsPage,
  renderRepoProjectWorkflowsPage,
  updateRepoWorkflowFromForm,
} from "./pages/repo-projects";
import { loadRepoSettings } from "../api/services/repo-settings";
import {
  canManageOrgProjectWorkflows,
  canManageUserProjectWorkflows,
  cardTypeToString,
  changeProjectStatus,
  deleteProjectById,
  findProjectById,
  findWorkflowByIdAndProject,
  repoProjectScope,
  type ProjectRow,
} from "../api/services/projects";
// Wave-24 repo social lists + collaboration panel (the parity survey's bench
// tier — the forks/stars/watchers trio and the settings/collaboration row).
import { loadRepoSocialData, renderRepoSocialPage } from "./pages/repo-social";
import {
  addCollaboratorFromForm,
  addTeamFromForm,
  canChangeRepoTeamAccess,
  changeAccessModeFromForm,
  loadCollaborationData,
  removeCollaboratorFromForm,
  removeTeamFromForm,
  renderCollaborationPage,
} from "./pages/settings-collaboration";
// Wave-25 repo tags + labels pages (the parity survey's TOP-2 dispatchable
// rows — the tags listing over the engine ref universe and the repo labels
// management page over the landed repo-label family).
import {
  applyTagDelete,
  loadTagsData,
  parseTagDeleteForm,
  renderTagsPage,
  TAG_RELEASE_ATTACHED_MESSAGE,
} from "./pages/tags";
import { loadTagListAux, tagListResponse } from "./pages/tag-list-aux";
import {
  createRepoLabelFromForm,
  deleteRepoLabelFromForm,
  editRepoLabelFromForm,
  loadRepoLabelsData,
  parseRepoLabelForm,
  renderRepoLabelsPage,
} from "./pages/repo-labels";
// Wave-26 milestone detail + edit and the fork form (the parity survey's
// TOP-3 and TOP-5 rows — the milestone row's dead ends and the fork-create
// form over the landed createFork machinery).
import {
  editMilestoneFromForm,
  loadMilestoneDetailData,
  loadMilestoneEditData,
  milestoneEditFormOf,
  renderMilestoneDetailPage,
  renderMilestoneEditPage,
} from "./pages/milestone-detail";
import {
  createForkFromForm,
  loadRepoForkData,
  parseRepoForkForm,
  renderRepoForkPage,
} from "./pages/repo-fork";
import { loadDashboardData, renderDashboardPage, renderLandingPage } from "./pages/dashboard";
import {
  loadExploreOrganizationsData,
  loadExploreReposData,
  loadExploreUsersData,
  renderExploreOrganizationsPage,
  renderExploreReposPage,
  renderExploreUsersPage,
} from "./pages/explore";
// The SPEC-0019 M2 explore code-search page (pages/explore-code.tsx — the
// navbar's fourth tab, the federation scan over every visible repo).
import { loadExploreCodeSearchData, renderExploreCodePage } from "./pages/explore-code";
import { loadOwnerHeatmapData, ownerHeatmapJsonBody } from "./pages/owner-heatmap";
import {
  loadOrgInboxIssuesData,
  loadOrgInboxMilestonesData,
  renderOrgInboxIssuesPage,
  renderOrgInboxMilestonesPage,
  resolveOrgInbox,
  type OrgInboxKind,
} from "./pages/org-inbox";
import {
  createIssueFromForm,
  loadNewIssueData,
  newIssueLocale,
  readNewIssueForm,
  renderNewIssuePage,
} from "./pages/new-issue";
import { issueNewChooseRedirect } from "./pages/issue-new-choose";
import { loadPullFilesData, renderPullFilesPage } from "./pages/pull-files";
// Wave-29 diffpatch downloads (the survey's row 4 — the four raw-text
// .diff/.patch routes; the loaders + Response builder live in the module,
// the handlers here beside their sibling dispatchers).
import { diffPatchTextResponse, loadCommitDiffPatch, loadPullDiffPatch } from "./pages/diffpatch-files";
// Wave-32 archive download + commit aux JSON (the survey's rows 1 + 3 —
// the streamed {ref}.{zip|tar.gz} tail and the load-branches-and-tags
// ContainedLinks feed; loaders + Response builders in the modules, the
// handlers here beside their sibling dispatchers).
import {
  archiveBadFormatResponse,
  loadRepoArchive,
  repoArchiveResponse,
} from "./pages/archive-files";
import { containedRefsResponse, loadCommitContainedRefs } from "./pages/commit-contained-refs";
// Wave-39 aux fragments (the survey's row 5 — the tree-list find-file feed
// and the branches/list name feed; loaders + Response builders in the
// modules, the handlers here beside their sibling dispatchers).
import { branchesListResponse, loadBranchesListAux } from "./pages/branches-list-aux";
import { loadTreeListAux, treeListResponse } from "./pages/tree-list-aux";
// Wave-43 tree-view envelope (the survey's PARTIAL row-5 gated half — the
// fileicon-unlocked fragment; loader + Response builder in the module, the
// handler here beside its sibling dispatchers).
import { loadTreeViewNodes, treeViewResponse } from "./pages/tree-view-aux";
// Wave-46 fragment mounts (the machinery waves' routes — the row-5 skips
// landing): the lastcommit handoff's loader/builder and the blob-excerpt
// stage-3 loader/builder (pages/repo-lastcommit-fragment.tsx +
// pages/repo-blob-excerpt-fragment.tsx), the handlers here beside their
// sibling dispatchers.
import { loadLastCommitFragment, lastCommitFragmentHtml, lastCommitFragmentResponse, parseLastCommitTail } from "./pages/repo-lastcommit-fragment";
import {
  blobExcerptFragmentHtml,
  blobExcerptFragmentResponse,
  hashFilePathForWebUI,
  loadBlobExcerptSection,
  parseBlobExcerptForm,
} from "./pages/repo-blob-excerpt-fragment";
import { loadPullCommitsData, renderPullCommitsPage } from "./pages/pull-commits";
import { loadCommitViewData, renderCommitViewPage } from "./pages/commit-view";
// The census R08 blame page (web.go:1729-1733's /blame family) over the
// engine's blame() read RPC.
import { loadBlameData, renderBlamePage } from "./pages/blame";
// The census R10 in-repo code search page (web.go:1768's /search literal)
// over the engine's grep() read RPC (SPEC-0015 M1).
import { loadRepoSearchData, renderRepoSearchPage } from "./pages/repo-search";
import { createPullFromForm, loadCompareData, readComparePullForm, renderComparePage } from "./pages/compare";
import {
  applyRepoBasics,
  canAdminRepo,
  createHookFromForm,
  editHookFromForm,
  fireHookTestDelivery,
  hookDeliveryQueueOf,
  loadHookDetailData,
  loadHooksSettings,
  loadMirrorSettings,
  loadRepoBasics,
  mirrorLocale,
  parseCreateHookForm,
  parseHookEditForm,
  parseRepoBasicsForm,
  renderHookDetailPage,
  renderHooksSettingsPage,
  renderMirrorSettingsPage,
  renderRepoSettingsPage,
  syncMirrorNow,
} from "./pages/settings";
import {
  applyBranchDelete,
  loadBranchesData,
  parseBranchDeleteForm,
  renderBranchesPage,
} from "./pages/branches";
import {
  createReleaseFromForm,
  deleteReleaseFromForm,
  editReleaseFromForm,
  loadEditReleaseData,
  loadNewReleaseData,
  loadReleaseDetailData,
  loadReleasesData,
  latestReleaseTagOf,
  parseNewReleaseForm,
  renderNewReleasePage,
  renderReleaseDetailPage,
  parseEditReleaseForm,
  parseReleaseDeleteForm,
  renderEditReleasePage,
  renderReleasesPage,
} from "./pages/releases";
import { listReleases } from "../api/services/releases";
import {
  applyBranchProtectionForm,
  applyDefaultBranchForm,
  loadDefaultBranchOptions,
  deleteRuleById,
  editFormOfRule,
  emptyBranchProtectionForm,
  loadBranchProtectionRules,
  loadOwnerIsOrg,
  parseBranchProtectionForm,
  parsePriorityIds,
  reorderRules,
  renderBranchProtectionEditPage,
  renderBranchProtectionListPage,
  type BranchProtectionEditData,
} from "./pages/branch-protection";
import { findIssueByRepoAndIndex } from "../api/services/issues";
import { deleteRepoHook, getOwnerHook, getRepoHook } from "../api/services/hooks";
import { findPullRequestByIndex } from "../api/services/pulls";
import { findRepositoryById } from "../api/services/repository";
import { toApiUser } from "../api/auth";
import { ApiError } from "../api/errors";
import { IssuesService } from "../issues/service";
import { deleteNoticesByIds, emptyNotices, parseNoticeIds } from "../services/notices";
import type { OrgRecord } from "../services/orgs/orgs";
// Window-2d: the four repo-settings tab modules.
import {
  applyRepoGitHook,
  loadRepoGitHookEdit,
  loadRepoGitHooks,
  parseRepoGitHookForm,
  renderRepoGitHookEditPage,
  renderRepoGitHooksListPage,
} from "./pages/repo-settings-githooks";
import {
  applyTagProtectionForm,
  deleteTagRuleById,
  editFormOfTag,
  emptyTagProtectionForm,
  loadProtectedTagRules,
  loadTagRuleById,
  parseTagProtectionForm,
  renderTagProtectionPage,
} from "./pages/repo-settings-tags";
import {
  addDeployKeyFromForm,
  deleteDeployKeyFromForm,
  loadRepoDeployKeys,
  parseDeployKeyDeleteForm,
  parseDeployKeyForm,
  renderRepoDeployKeysPage,
} from "./pages/repo-settings-deploy-keys";
import {
  loadRepoPublicAccess,
  parsePublicAccessForm,
  renderRepoPublicAccessPage,
  updateCodeUnitPublicAccess,
} from "./pages/repo-settings-public-access";
import {
  applyRepoWikiSettings,
  loadRepoWikiSettings,
  parseRepoWikiForm,
  renderRepoWikiSettingsPage,
} from "./pages/repo-settings-wiki";
// The census R11 arm: the four LFS settings read surfaces (upstream
// web.go:1249-1261's /settings/lfs group; the scan/join pipeline lives in
// services/lfs/read.ts).
import {
  loadLfsDetailPageData,
  loadLfsFilesPageData,
  loadLfsFindPageData,
  loadLfsPointersPageData,
  renderRepoSettingsLfsDetailPage,
  renderRepoSettingsLfsFindPage,
  renderRepoSettingsLfsListPage,
  renderRepoSettingsLfsPointersPage,
} from "./pages/repo-settings-lfs";
// The census C8 arm: the repo settings Actions secrets/variables sub-tabs
// (the org twin's route shape — org-settings-actions.tsx — under the shared
// settingsGate + MustEnableActions' repo_settings.has_actions arm).
import {
  applyRepoActionsSecretForm,
  applyRepoActionsVariableCreate,
  applyRepoActionsVariableUpdate,
  deleteRepoActionsSecret,
  deleteRepoActionsVariable,
  loadRepoActionsSecretsPageData,
  loadRepoActionsVariablesPageData,
  parseRepoActionsSecretDeleteForm,
  parseRepoActionsSecretForm,
  parseRepoActionsVariableForm,
  renderRepoActionsSecretsPage,
  renderRepoActionsVariablesPage,
} from "./pages/repo-settings-actions-secrets-variables";
// Window-2e C2b: the editor tails + cherrypick/patch modules.
import {
  loadEditorUploadData,
  parseUploadForm,
  renderEditorDeletePage,
  renderEditorUploadPage,
  uploadFormFromData,
} from "./pages/repo-editor-tails";
import {
  cherryPickFormFromData,
  commitCherryPickFromForm,
  commitPatchFromForm,
  loadEditorCherryPickData,
  loadEditorPatchData,
  patchFormFromData,
  readCherryPickForm,
  readPatchForm,
  renderEditorCherryPickPage,
  renderEditorPatchPage,
  splitCherryPickSuffix,
} from "./pages/repo-editor-cherrypick";
import { commitUploadFromForm, uploadFileToServer, uploadRemoveFromServer } from "../services/upload-staging";
import { branchRef, commitApiChangeError, deleteApiRefError, engineCell, engineReads, refTipMap, resolveNamedRef, ZERO_OID } from "../api/services/engine";
import {
  loadRepoMigrateData,
  migrateRepoFromForm,
  parseRepoMigrateForm,
  renderRepoMigratePage,
} from "./pages/repo-migrate";
// Window-2e: the aux/byte-surface modules.
import {
  loadHomeSitemapIndex,
  loadReposSitemap,
  loadUsersSitemap,
  parseSitemapIdx,
  sitemapXmlResponse,
} from "./pages/sitemap";
import {
  loadRepoSearchAux,
  loadTopicSearchAux,
  parseRepoSearchAuxQuery,
  parseTopicSearchAuxQuery,
  repoSearchAuxResponse,
  repoSearchCountOnlyResponse,
  SearchAuxParamError,
  topicSearchAuxResponse,
  type WebSearchAuxResults,
} from "./pages/search-aux";
import {
  loadActivityFeedsData,
  renderActivityFeedsPage,
  resolveActivityFeeds,
} from "./pages/activity-feeds";
import {
  loadUserFeedData,
  renderUserFeedAtom,
  renderUserFeedRss,
  USER_FEED_CONTENT_TYPES,
} from "./pages/user-feed-xml";
// The repo feed twins (the .rss/.atom channel bytes behind the repo header).
import {
  loadReleasesFeedData,
  RELEASES_FEED_CONTENT_TYPES,
  renderReleasesFeedAtom,
  renderReleasesFeedRss,
} from "./pages/releases-feed-xml";
import { loadTagsFeedData, TAGS_FEED_CONTENT_TYPES, renderTagsFeedAtom, renderTagsFeedRss } from "./pages/tags-feed-xml";
// Window-2e B2: the repo-scoped aux/fragment modules.
import {
  issuesSearchResponse,
  issuesSuggestionsResponse,
  loadIssuesSearchAux,
  loadIssuesSuggestionsAux,
  suggestionsIsPullFilter,
} from "./pages/issues-search-aux";
import {
  contentHistoryDetailFragmentResponse,
  contentHistoryListFragmentResponse,
  contentHistoryOverviewFragmentResponse,
  contentHistorySoftDeleteFragmentResponse,
  formInt64,
  issueAttachmentsFragmentResponse,
  issueInfoFragmentResponse,
  loadContentHistoryDetailFragment,
  loadContentHistoryListFragment,
  loadContentHistoryOverviewFragment,
  loadIssueAttachmentsFragment,
  loadIssueInfoFragment,
  resolveFragmentIssue,
  softDeleteContentHistoryFragment,
} from "./pages/issue-content-fragments";
import { loadPullMergeBoxData, pullMergeBoxFragmentHtml, pullMergeBoxFragmentResponse } from "./pages/pull-merge-box";
import {
  compareFeedServerErrorResponse,
  compareFeedTextResponse,
  loadCompareFeed,
  loadPullFilesRange,
  parsePullFilesRange,
  renderPullFilesRangePage,
  type CompareFeedRepo,
} from "./pages/compare-feeds";
import {
  loadPullFilesSingleCommit,
  parsePullFilesSingleCommit,
  renderPullFilesSingleCommitPage,
} from "./pages/pull-files-single-commit";
import { activityAuthorDataResponse, loadActivityAuthorData } from "./pages/activity-author-data";
import { loadRepoActivityData, renderRepoActivityPage } from "./pages/repo-activity";
import {
  chartDataResponse,
  loadChartFrequencyData,
  loadRepoContributorsData,
  renderRepoCodeFrequencyPage,
  renderRepoContributorsPage,
  renderRepoRecentCommitsPage,
  type RepoChartKind,
} from "./pages/repo-charts";
// The census R09-M2 commit-graph page (web.go:1738's /graph literal) over
// the M1 graphData engine RPC (SPEC-0017 M2); one handler answers the page
// and the ?div-only=true fragment twin.
import {
  loadGraphData,
  parseGraphQuery,
  renderGraphFragment,
  renderRepoGraphPage,
} from "./pages/repo-graph";
import {
  commentAttachmentsFragmentResponse,
  loadCommentAttachmentsFragment,
} from "./pages/comment-attachments-fragment";
// Window-2e C2: the wiki family.
import {
  createWikiPageFromForm,
  deleteWikiPageFromForm,
  editWikiPageFromForm,
  loadWikiEditData,
  loadWikiPagesData,
  loadWikiRevisionData,
  loadWikiViewData,
  parseWikiPageForm,
  renderWikiEditPage,
  renderWikiNewPage,
  renderWikiPagesPage,
  renderWikiRevisionPage,
  renderWikiStartPage,
  renderWikiViewPage,
} from "./pages/repo-wiki";
import type { WikiDoer } from "../services/wiki";
// The wiki raw byte arm (the markdown pipeline's `/wiki/raw/…` targets).
import { loadWikiRawBlob, wikiRawBlobResponse } from "./pages/wiki-raw";
// Window-2e C1: the global inbox.
import {
  loadDashboardMilestonesData,
  loadOverviewIssuesData,
  renderDashboardMilestonesPage,
  renderOverviewIssuesPage,
} from "./pages/global-inbox";
import {
  loadSubscriptionsData,
  loadWatchingData,
  renderNotificationSubscriptionsPage,
} from "./pages/notification-subscriptions";
import { demoModeEnabled } from "../services/demo-sweep";
import { shellAssetsFromManifest, type RepoRow, type UiContext } from "./ui-context";
import { resolveViewer, type Viewer } from "./viewer";

// ---------------------------------------------------------------------------
// The route clock (docs/research/render-wallclock-audit.md's follow-up 1).
// The wallclock audit made every loader/emitter clock-injectable, but the
// route call sites in THIS module were the one remaining hop: they hardcoded
// `new Date()` (or relied on the loaders' internal default), so no fixture
// could pin the rendered bytes one hop up — the blocker behind the
// admin-monitor-cron golden skip and route-driven feed determinism. The
// rendered-byte loader calls below consult `routeNow()`; with the override
// unset (production) the expression is exactly the wall clock, so every
// response is byte-identical to the pre-seam behavior — no request-visible
// surface change. Write-path `new Date()` stamps in this module (stored
// rows: notifications, project/workflow form writes) deliberately do NOT
// consult it — they are not rendered bytes at these call sites (the audit's
// (a-via-seeds) class: goldens pin stored rows directly).
//
// No request state: one module-scope variable, read at handler-call time,
// written ONLY by the test hook below (module-level pure — the audit's
// "no request-visible surface change" care).
// ---------------------------------------------------------------------------

/** The test-only route clock: returns the pinned Date, or null to fall back
 *  to the wall clock. */
type RouteClock = () => Date | null;

let ROUTE_CLOCK: RouteClock | null = null;

/**
 * TEST-ONLY (the name marks it): pin or clear the route clock that this
 * module's rendered-byte loader calls consult. `null` restores the wall
 * clock. Never call from production code — the golden harness
 * (`__tests__/goldens.test.ts`) is the only intended caller.
 */
export function __setRouteClockForTests(clock: RouteClock | null): void {
  ROUTE_CLOCK = clock;
}

/** The clock the rendered-byte loaders run on: the pinned override when the
 *  test harness set one, the wall clock otherwise (`ROUTE_CLOCK?.() ??
 *  new Date()`). */
function routeNow(): Date {
  return ROUTE_CLOCK?.() ?? new Date();
}

// ---------------------------------------------------------------------------
// Route parsers (the single source of truth — handlesUiRoute and uiRouter
// both read them; §2.2 "route knowledge has exactly one owner")
// ---------------------------------------------------------------------------

/** The claimed UI page families (§2.1 inventory). */
export type UiFamily = "home" | "commits" | "src";

/** A repo-scoped path the UI router owns, fully decoded. */
export interface UiRoute {
  family: UiFamily;
  /** Decoded owner segment, request casing preserved (D1 lookup folds). */
  owner: string;
  /** Decoded repo segment with exactly one trailing `.git` trimmed (§4.4
   *  gate convention; repo names ending `.git` are reserved, so the trim is
   *  unambiguous). */
  repo: string;
  /** Decoded remainder after the family literal, "/"-joined; `null` = the
   *  bare family URL (`/commits`, `/src`). */
  refSuffix: string | null;
}

// ---------------------------------------------------------------------------
// Wave-2 families (SPEC-0008 U3 extension: the code-tree redirect + the
// issues/pulls lists). A separate union, NOT extra members of `UiRoute`:
// `render.tsx`'s page switch stays exhaustive over the slice-1 three (the
// strictNullChecks fall-off-the-switch check), and the wave-2 dispatch lives
// entirely in this router — render.tsx never sees these routes.
// ---------------------------------------------------------------------------

/** The `/tree` family (pages/repo-home.tsx): upstream RedirectRepoTreeToSrc —
 *  the RAW (still-encoded) suffix swaps verbatim onto `/src/`. */
export interface TreeRoute {
  family: "tree";
  owner: string;
  repo: string;
  /** The still-encoded path tail after `/tree`, "/"-joined segments
   *  (`ctx.PathParamRaw("*")` parity); "" = the bare `/tree` (no upstream
   *  route → the §4.5 404 shell). */
  rawSuffix: string;
}

/** The `/issues` and `/pulls` list families (pages/issues-list.tsx): the
 *  bare URLs — the wave-3 detail routes below own the single-index tails. */
export interface IssuesListRoute {
  family: "issues" | "pulls";
  owner: string;
  repo: string;
}

/** The wave-3 detail family (pages/issue-detail.tsx): `/issues/{index}` and
 *  `/pulls/{index}` — one component over the shared issue rows; `urlKind`
 *  records which literal addressed it (upstream ViewIssue redirects the
 *  mismatched family onto `Issue.Link()`, issue_view.go:347-352). */
export interface IssueDetailRoute {
  family: "issue-detail";
  owner: string;
  repo: string;
  urlKind: "issues" | "pulls";
  index: number;
}

/** The wave-4 new-issue family (pages/new-issue.tsx): the form GET + the
 *  write POST — upstream's `/issues/new` (routers/web/repo/issue.go
 *  NewIssue/NewIssuePost). */
export interface IssueNewRoute {
  family: "issue-new" | "issue-new-choose";
  owner: string;
  repo: string;
}

/** The wave-4 settings families (pages/settings.tsx): the basics form, the
 *  webhooks sub-page, the mirror panel — wave 10 — and the wave-14 per-hook
 *  page with its two POST tails, each GET + POST except the two POST-only
 *  tails — admin-viewer-only surfaces. Wave 15 adds the protected-branches
 *  family (pages/branch-protection.tsx): the list, the create/edit form
 *  (upstream's `/edit` literal keyed by `?rule_name=` on the GET), the
 *  id-keyed delete and the priority reorder POSTs — upstream's literal
 *  route shapes (web.go:1206-1212). */
export interface SettingsRoute {
  family:
    | "settings"
    | "settings-hooks"
    | "settings-mirror"
    | "settings-hook-detail"
    | "settings-hook-test"
    | "settings-hook-delete"
    | "settings-branches"
    | "settings-branch-edit"
    | "settings-branch-delete"
    | "settings-branch-priority"
    // Window-2d: the four settings-tab modules.
    | "settings-githooks" // GET /settings/hooks/git
    | "settings-githook" // GET+POST /settings/hooks/git/{name}
    | "settings-tags" // GET+POST /settings/tags
    | "settings-tags-delete" // POST /settings/tags/delete
    | "settings-tag-detail" // GET+POST /settings/tags/{id}
    | "settings-keys" // GET+POST /settings/keys
    | "settings-keys-delete" // POST /settings/keys/delete
    | "settings-lfs" // GET /settings/lfs (the census R11 arm)
    | "settings-lfs-show" // GET /settings/lfs/show/{oid}
    | "settings-lfs-pointers" // GET /settings/lfs/pointers
    | "settings-lfs-find" // GET /settings/lfs/find
    | "settings-public-access" // GET+POST /settings/public_access
    | "settings-wiki" // GET+POST /settings/wiki (window-2d pass 2)
    | "settings-audit-logs" // GET /settings/audit_logs (the census R13 arm — GET only upstream, web.go:1279)
    // The census C8 arm: the repo settings Actions secrets/variables
    // sub-tabs (pages/repo-settings-actions-secrets-variables.tsx —
    // upstream web.go:1266-1278's `m.Group("/actions", ...)` behind
    // actions.MustEnableActions, inside the reqRepoAdmin settings group).
    | "settings-actions-secrets" // GET+POST /settings/actions/secrets
    | "settings-actions-secrets-delete" // POST /settings/actions/secrets/delete
    | "settings-actions-variables" // GET /settings/actions/variables
    | "settings-actions-variables-new" // POST /settings/actions/variables/new
    | "settings-actions-variables-edit" // POST /settings/actions/variables/{id}/edit
    | "settings-actions-variables-delete" // POST /settings/actions/variables/{id}/delete
    // The census C7 arm: the repo settings Actions RUNNERS sub-tab
    // (pages/repo-settings-actions-runners.tsx — upstream web.go:506-513's
    // addSettingsRunnersRoutes inside the /actions group). The literal
    // reset_registration_token claims ahead of the {id} combo (chi's
    // static-first order, web.go:507-512).
    | "settings-actions-runners" // GET /settings/actions/runners
    | "settings-actions-runners-token-reset" // POST /settings/actions/runners/reset_registration_token
    | "settings-actions-runners-edit" // GET+POST /settings/actions/runners/{id} (page + the description update)
    | "settings-actions-runners-update" // POST /settings/actions/runners/{id}/update-runner
    | "settings-actions-runners-delete" // POST /settings/actions/runners/{id}/delete
    // The census C9 arm: the repo settings Actions GENERAL sub-tab (pages/
    // repo-settings-actions-general.tsx — upstream web.go:1262-1278). The
    // page + its unit-toggle POST sit OUTSIDE MustEnableActions (the
    // disabled unit's re-entry); the bare literal's redirect carries the
    // unit arm INSIDE the gate (the enabled unit's shortcut).
    | "settings-actions" // GET /settings/actions (the redirect onto ./actions/general)
    | "settings-actions-general" // GET /settings/actions/general
    | "settings-actions-general-unit"; // POST /settings/actions/general/actions_unit
  owner: string;
  repo: string;
  /** The hook id (the detail/test/delete families only) or the rule id (the
   *  branch-delete family, the tag-detail family). */
  id?: number;
  /** The Git hook name (the settings-githook family) or the LFS oid (the
   *  settings-lfs-show family). */
  name?: string;
}

/** The wave-5 comment-write family (pages/issue-detail.tsx): upstream
 *  `m.Combo("/comments").Post(...)` under both issue URL families
 *  (routers/web/web.go:1376) — POST-only, the `status` field carries the
 *  close/reopen toggle. */
export interface IssueCommentRoute {
  family: "issue-comment";
  owner: string;
  repo: string;
  urlKind: "issues" | "pulls";
  index: number;
}

/** The wave-5 label-write family (pages/issue-detail.tsx): upstream
 *  `POST /issues/labels` — the sidebar JS dropdown's `data-update-url`
 *  (sidebar/label_list.tmpl:4-6), POST-only, admin-viewer-only. */
export interface IssueLabelsRoute {
  family: "issue-labels";
  owner: string;
  repo: string;
}

/** The wave-5 PR files family (pages/pull-files.tsx): upstream
 *  `m.Group("/files")` under the pulls group (web.go:1670-1680) — GET. */
export interface PullFilesRoute {
  family: "pull-files";
  owner: string;
  repo: string;
  index: number;
}

/** The PR commits tab family (pages/pull-commits.tsx): upstream's
 *  `/{index}/commits` GET under the pulls group (web.go ViewPullCommits,
 *  routers/web/repo/pull.go:631-668) — the tab menu's middle member. */
export interface PullCommitsRoute {
  family: "pull-commits";
  owner: string;
  repo: string;
  index: number;
}

/** The wave-16 branches family (pages/branches.tsx): upstream's
 *  `m.Get("/branches", repo.Branches)` list page plus the
 *  `m.Post("/branches/delete", repo.DeleteBranchPost)` write (web.go:1478-
 *  1482's group). The bare URL is the list (anonymous-capable); the delete
 *  rides the literal `/delete` tail (upstream's exact shape; the branch
 *  name rides the form field — Go's FormString reads upstream's
 *  query-string carrier too). Every other tail (`/branches/abc`,
 *  `/_new/*`, `/restore`) stays engine-owned — upstream's
 *  unregistered-route 404. */
export interface BranchesRoute {
  family: "branches" | "branch-delete" | "branch-create" | "branch-rename";
  owner: string;
  repo: string;
  /** The create form's source branch (the _new/{from} tail, decoded). */
  from?: string;
}

/** The wave-18 commit-view family (pages/commit-view.tsx): upstream's
 *  `m.Get("/commit/{sha:([a-f0-9]{7,64})$}", repo.Diff)` (web.go:1739) —
 *  the parity survey's #1 dead-end, the target of every commits-log /
 *  branches-list / PR-commits ShortSha link. The EXACT single-segment tail
 *  claims for ANY segment value (the hex-shape gate is the loader's 404
 *  arm — a non-hex segment, including a non-hex `foo.diff` dotted form,
 *  answers the §4.5 shell like upstream's pattern-miss 404); the DEEPER
 *  tails are lifted by their own families below (wave 29's dotted
 *  `{sha}.{diff|patch}` downloads — web.go:1760 — and wave 32's
 *  `{sha}/load-branches-and-tags` aux JSON — web.go:1740); junk stays
 *  engine-owned (see the page module's divergence notes). The bare
 *  `/commit` URL is unclaimed too (upstream has no such route). */
export interface CommitViewRoute {
  family: "commit-view";
  owner: string;
  repo: string;
  /** The decoded sha segment (validated at load time, not parse time). */
  sha: string;
}

/** The wave-20 releases family (pages/releases.tsx): upstream's releases
 *  group (web.go:1505-1514 — the parity survey's #4; the whole data side is
 *  landed, api/services/releases.ts + release-assets.ts + the SPEC-0005
 *  create arm): the bare URL is the list (`repo.Releases`, web.go:1506),
 *  `/releases/new` the create form + write (web.go:1517-1518, the writer
 *  gate), `/releases/latest` the latest-release 303 (web.go:1510 —
 *  `ctx.Redirect(release.Link())`), `/releases/tag/*` the single-release
 *  page (web.go:1509 `repo.SingleRelease` — the SAME list template over one
 *  row; the tail is the decoded tag name, slashes allowed, so the emitted
 *  `/releases/tag/{tag}` links — the API family's html_url shape — re-parse
 *  to the same route). Wave 33 (the survey's top-5 #4) adds the write
 *  group's edit/delete tails: `/releases/edit/*` the edit form + write
 *  (web.go:1519-1520 EditRelease/EditReleasePost — the writer gate, the
 *  decoded tail the URL-keyed tag, slashes allowed) and `/releases/delete`
 *  the delete write (web.go:1523 DeleteRelease — the edit page's red
 *  button). The `.rss`/`.atom` feed tails (web.go:1507-1508), the
 *  `/generate-notes` and `/attachments*` write tails and the
 *  `{id}/reactions` POST (web.go:1511-1526) stay unclaimed → the engine's
 *  404, exactly upstream's unregistered-route answer for them. */
export interface ReleasesRoute {
  family: "releases" | "release-new" | "release-latest" | "release-detail" | "release-edit" | "release-delete";
  owner: string;
  repo: string;
  /** The decoded tag tail after `/releases/tag/` (the detail family only;
   *  may bear slashes — refnames do) or after `/releases/edit/` (the edit
   *  family — the URL-keyed tag the loader resolves). */
  tag?: string;
}

/** The wave-41 releases download tail (pages/release-downloads.ts): upstream
 *  web.go:1513's `m.Get("/releases/attachments/{uuid}",
 *  repo.GetAttachment)` and web.go:1514's
 *  `m.Get("/releases/download/{vTag}/{fileName}", repo.RedirectDownload)` —
 *  the parity survey's top-5 #1, the serving half of the landed
 *  release-assets data (the download pages' links answer here). Both are
 *  binary serves, not pages; the routes sit in the releases group's gates
 *  (MustBeNotEmpty + reqRepoReleaseReader — the hasReleases unit gate). */
export interface ReleaseDownloadRoute {
  family: "release-attachment" | "release-download";
  owner: string;
  repo: string;
  /** The decoded uuid segment (the attachments family). */
  uuid?: string;
  /** The decoded {vTag}/{fileName} pair (the download family — chi's
   *  single-segment params, so a literal slash in either 404s upstream). */
  vTag?: string;
  fileName?: string;
}

/** The wave-2e releases feed twins (pages/releases-feed-xml.ts): upstream
 *  web.go:1506-1507's `/{owner}/{repo}/releases.rss|.atom` — the releases
 *  channel bytes behind the repo header's feed links. Binary XML serves,
 *  not pages; the routes sit in the releases group's gates (MustBeNotEmpty +
 *  reqRepoReleaseReader — the `releasesReadGate` pair). */
export interface ReleasesFeedRoute {
  family: "release-feed-rss" | "release-feed-atom";
  owner: string;
  repo: string;
}

/** The tags feed twins (pages/tags-feed-xml.ts): upstream web.go:1495-1496's
 *  `/{owner}/{repo}/tags.rss|.atom` — the tags channels (engine tag universe
 *  ∪ D1 release rows). The group's gate is reqUnitCodeReader (web.go:1502 —
 *  the §2.5 prologue IS that pair here) + MustBeNotEmpty; deliberately NO
 *  releases-unit gate (the tags twin's documented divergence from the
 *  releases feed above). */
export interface TagsFeedRoute {
  family: "tags-feed-rss" | "tags-feed-atom";
  owner: string;
  repo: string;
}

/** The wave-41 rendered blob views (pages/render-files.ts): upstream
 *  web.go:1715-1719's `/render` group — the three typed ref sub-routes over
 *  `repo.RenderFile` and the `/render/blob/{sha}` arm — the standalone-page
 *  renders the official bundle's external-render iframe fetches. Not a page
 *  family: the answer is a bare HTML fragment (or the "Unable to find
 *  renderer" 400 class — the module doc carries the pipeline mapping). */
export interface RenderFileRoute {
  family: "render-file";
  owner: string;
  repo: string;
  /** The typed-ref arms: the ref-type literal + the decoded ref+path suffix
   *  (the /src family's shape). */
  refType?: RefType;
  refSuffix?: string;
  /** The blob arm's decoded sha segment. */
  sha?: string;
}

/** The RAW + MEDIA byte-serving families (pages/raw-files.ts — upstream
 *  web.go:1699-1713's two groups, the survey's PARTIAL rows this wave
 *  closes): the three typed ref sub-routes (SingleDownload /
 *  SingleDownloadOrLFS), the `/blob/{sha}` arm (DownloadByID /
 *  DownloadByIDOrLFS), and the deprecated `/{raw,media}/*` backward-compat
 *  arm (RepoRefByType("") — getRefNameLegacy's guess). Not a page family:
 *  the answer is the byte Response (or the 404 family — the module doc
 *  carries the ServeBlob matrix and the divergence ledger). */
export interface RawMediaRoute {
  family: "raw-file" | "media-file";
  owner: string;
  repo: string;
  /** The typed-ref arms: the ref-type literal + the decoded ref+path
   *  suffix (the /src family's shape). */
  refType?: RefType;
  refSuffix?: string;
  /** The deprecated catch-all's decoded tail (the legacy guess input). */
  legacySuffix?: string;
  /** The blob arm's decoded sha segment. */
  sha?: string;
}

/** The wave-19 creation families (pages/repo-create.tsx + pages/
 *  org-create.tsx): upstream's reqSignIn `/repo/create` and `/org/create`
 *  groups (web.go:1094-1098 + 970-974 — the parity survey's #2, the
 *  authoring front door) — GET the form, POST the landed create arms
 *  (`POST /user/repos` / `POST /orgs/{org}/repos` user-repos + org-repos,
 *  and `POST /orgs`), success 303 onto the created owner's page. Claimed as
 *  EXACT literals before the owner/repo parse could read them as a
 *  repository named "create" under an owner named "repo"/"org" (the
 *  user-settings precedent; upstream's groups register ahead of the dynamic
 *  pairs and shadow such a repository identically). Every other
 *  `/repo|org/*` tail stays unclaimed → the engine's 404. */
export interface RepoCreateRoute {
  family: "repo-create";
}

export interface OrgCreateRoute {
  family: "org-create";
}

/** The wave-23 org members family (pages/org-members.tsx): upstream's
 *  `/org/{org}/members` literal (web.go:957-961, the `/org` group ahead of
 *  the dynamic pairs — a repository path `/org/{repo}/members` is shadowed
 *  identically, and the "org" owner name is create-time reserved besides,
 *  the repo-create precedent). The owner segment is the {org} param;
 *  anonymous-capable (the group's `optSignIn` is RequireSignInViewStrict,
 *  off at the pin) — the members listing's PublicOnly scope is the per-row
 *  gate. Every other `/org/*` tail stays unclaimed → the engine's 404. */
export interface OrgMembersRoute {
  family: "org-members";
  /** Decoded org segment (the upstream {org} param). */
  owner: string;
}

/** The wave-23 org repositories family (pages/org-repos.tsx): upstream's
 *  `/{username}/-/repositories` (web.go:1107's `/{username}/-` group's
 *  web.go:1134 repositories route) — the `-` pseudo-segment namespace claims
 *  exactly the repositories tail; a plain USER name 404-shells at resolve
 *  time (upstream org.Repositories' `org == nil` arm). Every other `/-*`
 *  tail (heatmap, packages, code) stays unclaimed → the engine's 404
 *  (projects landed in wave 37 — pages/owner-projects.tsx). */
export interface OrgRepositoriesRoute {
  family: "org-repositories";
  /** Decoded owner segment (org rows only at resolve time). */
  owner: string;
}

/** The SPEC-0016 M2 owner packages subtree (pages/packages.tsx): upstream's
 *  `/{username}/-` group's packages routes (web.go:1109-1121 — the group's
 *  `context.PackageAssignment()` + `reqPackageAccess(read)` wraps fold into
 *  the resolution seam) — the list literal (ListPackages), `/{type}/{name}`
 *  the RedirectToLastVersion 303 (package.go:137), the `/versions` tail
 *  (ListPackageVersions, the static literal outranking the `{version}`
 *  param exactly as chi registers it), the `/{version}` view
 *  (ViewPackageVersion), and the `/{version}/files/{fileid}` byte download
 *  (DownloadPackageFile, package.go:530). */
export interface OwnerPackagesRoute {
  family:
    | "owner-packages" // GET /packages
    | "owner-package-redirect" // GET /packages/{type}/{name} → 303 latest
    | "owner-package-versions" // GET /packages/{type}/{name}/versions
    | "owner-package-version-view" // GET /packages/{type}/{name}/{version}
    | "owner-package-file-download" // GET .../{version}/files/{fileid}
  ;
  /** Decoded owner segment (user-or-org rows at resolve time). */
  owner: string;
  /** The decoded registry type + package name (the depth families). */
  type?: string;
  name?: string;
  /** The decoded version (the view + download families). */
  version?: string;
  /** The parsed file id (the download family; the PathParamInt64 parity —
   *  "007" parses as 7, junk shapes stay unclaimed). */
  fileId?: number;
}

/** The SPEC-0016 M2 repo packages tab (pages/packages.tsx): upstream's
 *  `/{username}/{reponame}/packages` group's bare literal (web.go:1546 —
 *  repo.Packages). The group's MustEnableRepoProjects-shaped unit gate
 *  (`repo_settings.has_packages`) runs at the handler off the
 *  resolveUiRequest flag — the shell tab reads the SAME toggle. */
export interface RepoPackagesRoute {
  family: "repo-packages";
  owner: string;
  repo: string;
}

/** The ORG-scoped inbox families (pages/org-inbox.tsx — this wave's R07):
 *  upstream web.go:986-991's `/org/{org}/{issues|pulls|milestones}` +
 *  `/{team}` tails under `OrgAssignment(RequireMember, RequireTeamMember)`.
 *  The `{org}` segment is the URL's login (the team tail is the team's
 *  DISPLAY name — resolution lowercases). */
export interface OrgInboxRoute {
  family: "org-inbox";
  owner: string;
  kind: "issues" | "pulls" | "milestones";
  /** The `{team}` tail's decoded segment (absent = the bare route). */
  team?: string;
}

/** The owner HEATMAP JSON family (pages/owner-heatmap.ts — this wave): the
 *  `/{username}/-` group's `m.Get("/heatmap", user.DashboardHeatmap)`
 *  (web.go:1135) — the web pair-shape JSON the official bundle's profile
 *  widget fetches (features/heatmap.ts → `#user-heatmap`'s
 *  `data-heatmap-url`). Not a page: the answer is the JSON body (or the
 *  404 shell — the `IsUserVisibleToViewer` gate). The owner resolves
 *  USER-side (the org arm is census R06's org-scoped aggregation). */
export interface OwnerHeatmapRoute {
  family: "owner-heatmap";
  /** Decoded owner segment (user rows only at resolve time — the R06
   *  boundary note in the module header). */
  owner: string;
}

/** The codesearch-M1 owner code-search family (pages/user-code-search.tsx —
 *  this wave): the `/{username}/-` group's `/code` literal (upstream
 *  user.CodeSearch, web.go:1136's `m.Get("/code", user.CodeSearch)` in the
 *  `/{username}/-` group) — the federated code search page over the
 *  owner's repos. The owner resolves user-or-org at load time (the
 *  packages family's owner-resolution twin without the package-access
 *  gate — the module header's §5.4/§5.9 note). */
export interface UserCodeSearchRoute {
  family: "user-code-search";
  /** Decoded owner segment (user-or-org rows at resolve time). */
  owner: string;
}

/** The wave-37 owner projects list family (pages/owner-projects.tsx):
 *  upstream's `/{username}/-/projects` (web.go:1107's `/{username}/-`
 *  group's read group, web.go:1143-1145 — `m.Get("", org.Projects)` plus
 *  the `/{id}` board tails) — the parity survey's regenerated top-5 row 5.
 *  The `-` pseudo-segment namespace claims EXACTLY the bare projects tail;
 *  the owner resolves user-or-org at load time (upstream's single handler
 *  branches on ContextUser.IsOrganization). Wave 40 (pages/
 *  owner-project-board.tsx) claims the board depth and the write group —
 *  the survey's follow-up row. */
export interface OwnerProjectsRoute {
  family: "owner-projects";
  /** Decoded owner segment (user-or-org rows at resolve time). */
  owner: string;
}

/** The wave-40 owner projects BOARD families (pages/owner-project-board.tsx):
 *  upstream's web.go:1140-1155 board view + write group (the survey's
 *  follow-up row) over the `/-/projects` depth — `/{id}` the board view
 *  (org.ViewProject), `/new` + `/{id}/edit` the GET+POST form combos,
 *  `/{id}/delete` + `/{id}/open|close` the POST writes, `/{id}/columns/new`
 *  + `/{id}/{columnID}/default` the form-compatible board-helper POSTs
 *  (addProjectBoardRoutes, web.go:331-345), and the `/{id}/workflows[/{wid}
 *  [/delete]]` workflow tails (addProjectWorkflowRoutes, web.go:327-331).
 *  The `new` literal outranks the numeric `{id}` shapes (upstream registers
 *  it first, chi tree order); the id shapes claim positive integers only —
 *  a junk segment stays unclaimed → the engine's 404 (upstream's
 *  PathParamInt64-zero ServerError 500 arm, the landed uniform not-found
 *  answer). The board-helper arms whose upstream methods are PUT/DELETE
 *  (`/{columnID}`) or whose controls are pure drag-drop JSON fetches
 *  (`/move`, `/{columnID}/move`) stay unclaimed → the engine's 404 — the
 *  page module documents the no-JS reductions, never dead controls. */
export interface OwnerProjectBoardRoute {
  family:
    | "owner-project-board" // GET /{id}
    | "owner-project-new" // GET+POST /new
    | "owner-project-edit" // GET+POST /{id}/edit
    | "owner-project-delete" // POST /{id}/delete
    | "owner-project-status" // POST /{id}/open|close
    | "owner-project-column-new" // POST /{id}/columns/new
    | "owner-project-column-default" // POST /{id}/{columnID}/default
    | "owner-project-workflows" // GET+POST /{id}/workflows[/{wid}]
    | "owner-project-workflow-delete" // POST /{id}/workflows/{wid}/delete
  ;
  /** Decoded owner segment (user-or-org rows at resolve time). */
  owner: string;
  /** The parsed board id (the numeric families; "new" carries none). */
  id?: number;
  /** open|close (the status family only). */
  action?: "open" | "close";
  /** The column id (the column-default family only). */
  columnId?: number;
  /** The workflow id (the workflows-with-wid and workflow-delete families). */
  workflowId?: number;
}

/** The wave-45 repo projects families (pages/repo-projects.tsx): upstream's
 *  `/{username}/{reponame}/projects` group (web.go:1544-1563 — the survey's
 *  re-ranked #1, the F-family row the restored `repo === "-"` guard held):
 *  the bare literal the LIST (repo.Projects), `/new` the write group's
 *  GET+POST form combo, `/{id}` the board view (repo.ViewProject), the
 *  `/{id}/edit|delete|open|close` project writes, `/{id}/columns/new` +
 *  `/{id}/{columnID}/default` the form-compatible board-helper POSTs
 *  (addProjectBoardRoutes' live half), and the
 *  `/{id}/workflows[/{wid}[/delete]]` workflow tails (addProjectWorkflowRoutes
 *  — repo.ProjectWorkflows → RenderWorkflows). The `new` literal outranks
 *  the numeric `{id}` shapes (upstream registers it first, chi tree order);
 *  the id shapes claim positive integers only — a junk segment stays
 *  unclaimed → the engine's 404 (upstream's PathParamInt64-zero ServerError
 *  arm, the landed uniform not-found answer). The board-helper arms whose
 *  upstream methods are PUT/DELETE (`/{columnID}`) or whose controls are
 *  pure drag-drop JSON fetches (`/move`, `/{columnID}/move`) stay unclaimed
 *  → the engine's 404 — the owner-board posture, page module documents the
 *  no-JS reductions. The group's gates (MustEnableRepoProjects reduced to
 *  the loaded `repoHasProjects` toggle; the write ladder =
 *  reqRepoProjectsWriter + RepoMustNotBeArchived → the shared repo write
 *  gate) run at the handlers. */
export interface RepoProjectsRoute {
  family:
    | "repo-projects" // GET /projects
    | "repo-project-new" // GET+POST /projects/new
    | "repo-project-board" // GET /projects/{id}
    | "repo-project-edit" // GET+POST /projects/{id}/edit
    | "repo-project-delete" // POST /projects/{id}/delete
    | "repo-project-status" // POST /projects/{id}/open|close
    | "repo-project-column-new" // POST /projects/{id}/columns/new
    | "repo-project-column-default" // POST /projects/{id}/{columnID}/default
    | "repo-project-workflows" // GET+POST /projects/{id}/workflows[/{wid}]
    | "repo-project-workflow-delete" // POST /projects/{id}/workflows/{wid}/delete
  ;
  owner: string;
  repo: string;
  /** The parsed board id (the numeric families; "new" carries none). */
  id?: number;
  /** open|close (the status family only). */
  action?: "open" | "close";
  /** The column id (the column-default family only). */
  columnId?: number;
  /** The workflow id (the workflows-with-wid and workflow-delete families). */
  workflowId?: number;
}

/** The wave-24 repo social list families (pages/repo-social.tsx): upstream's
 *  three bare repo-scoped literals — `/forks` (web.go:1759), `/stars`
 *  (web.go:1766), `/watchers` (web.go:1767) — the parity survey's bench
 *  trio, one `listRefs`-free read each over the landed social/fork services.
 *  GET-only; every deeper tail stays unclaimed → the engine's 404. */
export interface RepoSocialRoute {
  family: "forks" | "stars" | "watchers";
  owner: string;
  repo: string;
}

/** The wave-24 collaboration settings family (pages/settings-collaboration.tsx):
 *  upstream's `/settings/collaboration` group (web.go:1194-1204) — the
 *  `m.Combo("")` panel (GET the render, POST the add-collaborator write)
 *  plus the four POST-only write tails with upstream's exact literal names
 *  (the JS dropdown's /access_mode, the /delete remove, the org team
 *  /team add and /team/delete remove; the ids ride the form fields —
 *  upstream's FormInt64 carriers). */
export interface SettingsCollaborationRoute {
  family:
    | "settings-collaboration"
    | "settings-collab-access-mode"
    | "settings-collab-delete"
    | "settings-collab-team-add"
    | "settings-collab-team-delete";
  owner: string;
  repo: string;
}

/** The wave-25 tags family (pages/tags.tsx + pages/tag-list-aux.ts):
 *  upstream's repo tags group's list route (web.go:1493-1496 —
 *  `m.Get("", context.RepoRefByDefaultBranch(), repo.TagsList)` under the
 *  `/tags` group) — the parity survey's TOP-1 row, the bare repo-scoped
 *  literal over the engine ref universe. Wave 33 (the survey's top-5 #2)
 *  adds the group's other two routes: `/tags/list` the aux JSON
 *  (web.go:1499 GetTagList — the `{"results":[names]}` branchTagSearchResponse
 *  shape, GET-only, pages/tag-list-aux.ts) and `/tags/delete` the delete
 *  write (web.go:1501 — reqSignIn + reqRepoCodeWriter +
 *  RepoMustNotBeArchived, POST-only, the tags page's per-row control). The
 *  `.rss`/`.atom` feed tails and every deeper tail stay unclaimed → the
 *  engine's 404, exactly upstream's unregistered-route answer. */
export interface TagsRoute {
  family: "tags" | "tags-list-aux" | "tags-delete";
  owner: string;
  repo: string;
}

/** The wave-25 repo labels families (pages/repo-labels.tsx): upstream's
 *  labels page (web.go:1338 `repo.RetrieveLabelsForList, repo.Labels` in
 *  the optSignIn + reqRepoIssuesOrPullsReader group — anonymous-capable)
 *  plus the three POST write tails (`/labels/new`, `/labels/edit`,
 *  `/labels/delete` — web.go:1417-1422 under reqSignIn +
 *  RepoMustNotBeArchived + reqRepoIssuesOrPullsWriter; the survey's TOP-2
 *  row). The repo-scoped `labels` THIRD segment never collides with the
 *  wave-14 org literal (which claims `/{org}/labels` — `labels` as the
 *  SECOND segment — upstream shadows that repo identically). The
 *  `/labels/initialize` template loader and every deeper tail stay
 *  unclaimed → the engine's 404. */
export interface RepoLabelsRoute {
  family: "repo-labels" | "repo-label-new" | "repo-label-edit" | "repo-label-delete";
  owner: string;
  repo: string;
}

/** The wave-26 milestone detail family (pages/milestone-detail.tsx):
 *  upstream's SINGULAR `m.Get("/milestone/{id}", repo.MilestoneIssuesAndPulls)`
 *  (web.go:1340 — the parity survey's TOP-3 row, the milestones LIST's
 *  title-link target; the plural /milestones group never claimed this
 *  shape). The exact single-segment tail is claimed for ANY segment value —
 *  a non-numeric or foreign id 404-shells through the loader (upstream
 *  PathParamInt64's zero + GetMilestoneByRepoID's NotFound), the
 *  commit-view sha convention. Deeper tails (`/{id}/foo`) stay unclaimed →
 *  the engine's 404 (upstream registers none here either). */
export interface MilestoneDetailRoute {
  family: "milestone-detail";
  owner: string;
  repo: string;
  /** The decoded id segment (validated at load time, not parse time). */
  id: string;
}

/** The wave-26 milestone edit family (pages/milestone-detail.tsx): the
 *  `{id}/edit` combo under the plural /milestones group (web.go:1427-1428 —
 *  `m.Get("/{id}/edit", repo.EditMilestone)` + the POST
 *  EditMilestonePost), the write group's gate running at the handlers (the
 *  labels-write convention). Upstream's sibling writes — `/{id}/{action}`
 *  (ChangeMilestoneStatus close/open) and `/delete` — stay unclaimed → the
 *  engine's 404: this slice renders no dead controls for them. */
export interface MilestoneEditRoute {
  family: "milestone-edit";
  owner: string;
  repo: string;
  /** The decoded id segment (validated at load time, not parse time). */
  id: string;
}

/** The wave-26 fork-form family (pages/repo-fork.tsx): upstream's
 *  `m.Combo("/fork").Get(repo.Fork).Post(...)` (web.go:1490 — the survey's
 *  TOP-5 row, DISTINCT from the landed forks LIST literal which claims the
 *  bare `/forks`). The signed-in gate + the empty-source 404 run at the
 *  handlers (upstream reqSignIn + getForkRepository's IsEmpty arm); the
 *  deeper `/fork/*` tails stay unclaimed → the engine's 404. */
export interface RepoForkRoute {
  family: "repo-fork";
  owner: string;
  repo: string;
}

/** The wave-29 diffpatch download family (pages/diffpatch-files.ts): the
 *  four raw-text routes — upstream web.go:1760's
 *  `/commit/{sha:([a-f0-9]{7,64})}.{ext:patch|diff}` (repo.RawDiff) and
 *  web.go:1657-1658's `/{index}.diff` + `/{index}.patch` under the pulls
 *  group (repo.DownloadPullDiff/Patch). The commit arm claims the DOTTED
 *  hex-shaped segment (7..64, case-folded — the load-time shape gate) out of
 *  wave-18's any-value single tail; every other segment keeps the commit-view
 *  claim (a non-hex `foo.diff` 404-shells there, upstream's pattern miss).
 *  The pull arm admits `\\d+.{diff|patch}` exactly (the landed API seam's
 *  convention — a negative or junk index upstream-404s too, chi's
 *  PathParamInt64 miss). The response is raw TEXT, not a page (the module
 *  doc carries the contract). */
export interface DiffPatchRoute {
  family: "commit-diffpatch" | "pull-diffpatch";
  owner: string;
  repo: string;
  /** The commit family: the sha segment before the `.ext` suffix. */
  sha?: string;
  /** The pull family: the numeric index. */
  index?: number;
  /** The raw format the `.ext` suffix picked. */
  ext: "diff" | "patch";
}

/** The wave-32 archive download family (pages/archive-files.ts): upstream
 *  web.go:1689's `m.Get("/*", repo.Download)` under the /archive group —
 *  the wildcard tail is `REF.zip` | `REF.tar.gz` (`.bundle` parses upstream
 *  as a third format; the builder refuses, the 400 class), multi-segment
 *  ref names included, the BARE `/archive` claimed too (chi's `/*` matches
 *  the empty tail; `SplitArchiveNameType("")` is the same 400 arm). The
 *  response is a streamed FILE, not a page (the module doc carries the
 *  header matrix); the POST half (InitiateDownload, web.go:1690) stays
 *  engine-owned. */
export interface RepoArchiveRoute {
  family: "repo-archive";
  owner: string;
  repo: string;
  /** The wildcard tail verbatim ("" for the bare URL): `REF.{zip|tar.gz}`. */
  refExt: string;
}

/** The wave-32 commit aux-JSON family (pages/commit-contained-refs.ts):
 *  upstream web.go:1740's
 *  `{sha:([a-f0-9]{7,64})}/load-branches-and-tags` — the HEX-shaped sha
 *  lifts out of wave-18's single-tail view claim (a non-hex sha with the
 *  literal tail is upstream's pattern miss → engine-owned). The response is
 *  JSON, not a page (the module doc carries the shape + cost posture). */
export interface CommitContainedRefsRoute {
  family: "commit-contained-refs";
  owner: string;
  repo: string;
  /** The commit sha segment (hex-shaped 7..64, case-folded). */
  sha: string;
}

/** The wave-39 pasted-blob-URL redirect family (pages/repo-home.tsx's
 *  blobRedirectResponse): upstream web.go:1757's `m.Get("/blob/*",
 *  repo.RedirectRepoBlobToCommit)` — the wave-2 tree-redirect twin, the RAW
 *  (still-encoded) suffix swapped verbatim onto `/src/commit/`. */
export interface BlobRedirectRoute {
  family: "blob-redirect";
  owner: string;
  repo: string;
  /** The still-encoded path tail after `/blob` (`ctx.PathParamRaw("*")`
   *  parity); "" = the bare `/blob` (no upstream route → the §4.5 404
   *  shell, the tree family's arm). */
  rawSuffix: string;
}

/** The wave-39 find-file aux-JSON family (pages/tree-list-aux.ts): upstream
 *  web.go:1297-1306's `/{branch|tag|commit}/*` sub-routes over
 *  `repo.TreeList` — the ref-type literal is the route shape (the forced-type
 *  middleware), the decoded tail is the ref+path suffix (the /src family's
 *  shape; the handler walks the ROOT tree, the tail's path half is ignored —
 *  the module doc). The response is JSON, not a page. */
export interface TreeListAuxRoute {
  family: "tree-list-aux";
  owner: string;
  repo: string;
  /** The forced ref type (web.go:1298-1300's three sub-routes). */
  refType: RefType;
  /** The decoded ref+path tail after the type literal. */
  refSuffix: string;
}

/** The wave-39 branches aux-JSON family (pages/branches-list-aux.ts):
 *  upstream web.go:1695's `m.Get("/list", repo.GetBranchesList)` under the
 *  `/branches` group — the `{"results":[names]}` feed (the wave-33
 *  tags-list-aux twin; the group's MustBeNotEmpty 404-shells empty repos at
 *  the handler). The response is JSON, not a page. */
export interface BranchesListAuxRoute {
  family: "branches-list-aux";
  owner: string;
  repo: string;
}

/** The wave-43 tree-view envelope family (pages/tree-view-aux.ts): upstream
 *  web.go:1302-1306's `/{branch|tag|commit}/*` sub-routes over
 *  `repo.TreeViewNodes` (routers/web/repo/treelist.go:147-155) — the
 *  tree-list twin's route shape (the ref-type literal is the route shape,
 *  the decoded tail is the ref+path suffix, the /src family's shape), with
 *  the tail's PATH half now MEANINGFUL (the listing roots at it) and the
 *  `?sub_path=` query naming the expansion chain. The response is the
 *  `{fileTreeNodes, renderedIconPool}` JSON envelope, not a page. */
export interface TreeViewAuxRoute {
  family: "tree-view-aux";
  owner: string;
  repo: string;
  /** The forced ref type (web.go:1302-1306's three sub-routes). */
  refType: RefType;
  /** The decoded ref+path tail after the type literal. */
  refSuffix: string;
}

/** The wave-46 lastcommit fragment family (pages/repo-lastcommit-fragment.tsx
 *  — the machinery wave's route handoff): upstream web.go:1761's
 *  `m.Get("/lastcommit/*", context.RepoRefByType(git.RefTypeCommit),
 *  repo.LastCommit)` — the wildcard tail is the commit id + treePath
 *  (repo.go:915-921: the first segment is the 7..64-hex-shaped object id, the
 *  remainder the listed directory; the bare tail is upstream's default-branch
 *  arm, the landed convention's 404-shell divergence — the module doc's HEAD
 *  note). The response is the tplRepoViewList HTML fragment, not a page. */
export interface LastCommitRoute {
  family: "lastcommit";
  owner: string;
  repo: string;
  /** The decoded `/lastcommit` tail (per-segment decode —
   *  parseLastCommitTail's input contract; `""` = the bare URL). */
  rawTail: string;
}

/** The wave-46 blob-excerpt fragment families (pages/repo-blob-excerpt-
 *  fragment.tsx — the machinery's stage 3): upstream web.go:1735's
 *  `m.Get("/blob_excerpt/{sha}", …)` repo twin and web.go:1618's wiki twin
 *  (the `/{username}/{reponame}/wiki` group — PageIsWiki swaps the read onto
 *  the sibling wiki storage repo and the buttons' BaseLink). `{sha}` is a
 *  plain chi single-segment param (NO hex shape — any value; the handler's
 *  GetCommit miss is the 404 family). The response is the tplBlobExcerpt
 *  `<tr>` fragment, not a page. */
export interface BlobExcerptRoute {
  family: "blob-excerpt" | "wiki-blob-excerpt";
  owner: string;
  repo: string;
  /** The decoded `{sha}` segment (the after-commit id, unvalidated). */
  sha: string;
}


/** The wave-11 review-write families (pages/pull-reviews.tsx): upstream's
 *  three web POSTs — the verdict form's
 *  `/pulls/{index}/files/reviews/submit` (web.go:1678, the index rides the
 *  URL) and the repo-scoped `/issues/request_review` + `/issues/
 *  dismiss_review` (web.go:1435-1436, the issue/review ids ride the form —
 *  exactly upstream's field-carried shapes). POST-only. */
export interface PullReviewRoute {
  family:
    | "pull-review-submit"
    | "issue-request-review"
    | "issue-dismiss-review"
    | "pulls-new-redirect";
  owner: string;
  repo: string;
  /** The PR index (the submit family only). */
  index?: number;
}

/** The wave-6 milestones list family (pages/milestones.tsx): upstream
 *  `m.Get("/milestones", repo.Milestones)` (web.go:1339) — GET, `?state=`
 *  facet. Wave 26 moved the `{id}/edit` claim into MilestoneEditRoute and
 *  the singular `/milestone/{id}` detail into MilestoneDetailRoute; the
 *  remaining tails (`/{id}/{action}`, `/delete`) stay engine-owned. */
export interface MilestonesRoute {
  family: "milestones";
  owner: string;
  repo: string;
}

/** The wave-6 new-milestone family (pages/milestones.tsx): upstream
 *  `m.Combo("/new").Get(repo.NewMilestone).Post(repo.NewMilestonePost)`
 *  under the /milestones group (web.go:1424-1425). */
export interface MilestoneNewRoute {
  family: "milestone-new";
  owner: string;
  repo: string;
}

/** The wave-6 single-segment family — EXTENDED in wave 7 into the OWNER
 *  home (pages/org-home.tsx + pages/user-profile.tsx): upstream's
 *  `/{username}` route answers user AND org names through one handler
 *  (`OwnerProfile` — routers/web/user/profile.go:37, dispatching on
 *  `ContextUser.IsOrganization()`), so ONE parse family owns the shape and
 *  the resolution picks the page: an org row renders the org home (the wave-6
 *  `resolveOrgHome` seam), a user row the user profile, a renamed name 307s
 *  onto the target. The dispatcher never consults `handlesUiRoute` for it
 *  (single-segment requests fall straight to `app.fetch`, where this
 *  sub-app's registration answers), but the parser is still the single
 *  owner of the shape. */
export interface OwnerHomeRoute {
  family: "owner-home";
  /** Decoded owner segment — the user or org name. */
  owner: string;
}

/** Window-2e: the user/org feed envelopes (pages/user-feed-xml.ts —
 *  upstream UsernameSubRoute's .rss/.atom suffix dispatch serves ORGS too,
 *  profile.go:33). */
export interface UserFeedRoute {
  family: "user-feed-rss" | "user-feed-atom";
  /** The owner segment with the suffix stripped. */
  owner: string;
}

/** Window-2e C1: the global inbox pages (pages/global-inbox.tsx). */
export interface GlobalInboxRoute {
  family: "global-issues" | "global-pulls" | "global-milestones";
}

/** Window-2e C2: the wiki family (pages/repo-wiki.tsx — the ?action=
 *  dispatch happens in the handler, per the module's verified grammar). */
export interface WikiRoute {
  family: "wiki";
  owner: string;
  repo: string;
  /** The wildcard tail VERBATIM (decoded; "" → the Home page). */
  rawTail: string;
}

/** The wiki raw byte arm (pages/wiki-raw.ts — web.go:1621's
 *  `m.Get("/raw/*", repo.WikiRaw)`): the bytes behind the markdown
 *  pipeline's `![img](/wiki/raw/…)` rewrites. GET-only. */
export interface WikiRawRoute {
  family: "wiki-raw";
  owner: string;
  repo: string;
  /** The decoded `/raw` tail (per-segment decode + "/" join — the
   *  wiki family's rawTail convention; "" never claims here: the
   *  bare `/wiki/raw` tail stays with the page family, exactly
   *  upstream's chi wildcard which does not match `/raw`). */
  rawTail: string;
}

/** The wave-8 file-editor family (pages/file-editor.tsx): upstream's
 *  `/{editor_action:_edit|_new|_delete}/*` Combos under
 *  `RepoRefByType(git.RefTypeBranch)` (web.go:1453-1461) at the wave brief's
 *  literal names (`new`/`edit`/`delete`). The tail is the decoded
 *  branch+path rest; it resolves against the BRANCH universe only at page
 *  time (pages/file-editor.tsx's loadFileEditorData — the /src walk's
 *  branch arm, so a slash-bearing branch takes the shortest existing
 *  prefix). The bare literals stay unclaimed: upstream chi's `/*` requires
 *  the tail too. */
export interface FileEditorRoute {
  family: "file-new" | "file-edit" | "file-delete" | "file-upload" | "editor-patch" | "editor-cherrypick";
  owner: string;
  repo: string;
  /** Decoded branch+path tail after the family literal (never claimed
   *  empty). */
  refSuffix: string;
}

/** The blame page family (pages/blame.tsx): upstream's blame group —
 *  web.go:1729-1733's `m.Group("/blame", ...)` with `/branch/*`, `/tag/*`
 *  and `/commit/*` tails → repo.RefBlame (routers/web/repo/blame.go; the
 *  census R08 row's route shape). The tail is the decoded
 *  refType-prefixed ref+path rest — it re-parses through the SAME
 *  splitRefSuffix/resolveRefSuffix walk the /src family uses (pages/
 *  blame.tsx's loadBlameData; an empty tree path is blame.go:48-51's
 *  NotFound arm, answered there as the 404 shell). The bare `/blame` stays
 *  unclaimed: upstream chi requires the tail, and the engine answers. */
export interface BlameRoute {
  family: "blame";
  owner: string;
  repo: string;
  /** Decoded refType+ref+path tail after the family literal (never claimed
   *  empty; never a bare refType). */
  refSuffix: string;
}

/** The census R10 in-repo code search page family (pages/repo-search.tsx):
 *  upstream web.go:1768's `m.Get("/search", reqUnitCodeReader, repo.Search)`
 *  — the exact bare literal inside the stars/watchers group (web.go:1764-1773,
 *  `optSignIn, context.RepoAssignment`; no MustBeNotEmpty). The query arms
 *  (`q`, `search_mode`, `page`, and our `path` pathspec passthrough) ride the
 *  URL, not the path — the family claims the bare literal only; deeper tails
 *  stay unclaimed → the engine's 404, exactly upstream's unregistered-route
 *  answer. */
export interface RepoSearchRoute {
  family: "repo-search";
  owner: string;
  repo: string;
}

/** The wave-9 site root (pages/dashboard.tsx): upstream `Home`
 *  (routers/web/home.go:26-44) — `/` serves the signed-in dashboard, the
 *  anonymous landing. The dispatcher never consults `handlesUiRoute` for it
 *  (the root is not repo-scoped; the uiRouter registration answers), but the
 *  parser stays the single owner of the shape. */
export interface SiteHomeRoute {
  family: "site-home";
}

/** The wave-10 notifications family (pages/notifications.tsx): upstream's
 *  web notifications group (web.go:1784-1791, reqSignIn) at the literal
 *  `/notifications` — the list page; `/notifications/new` the unread-count
 *  JSON; `/notifications/status` + `/notifications/purge` the POST-only
 *  writes. Claimed as EXACT literals before the owner-home parse could read
 *  `/notifications` as a username (the explore precedent; the literals bind
 *  case-sensitively, so `/Notifications` stays an owner home) and before the
 *  repo-scoped parse could read `/notifications/status` as an
 *  owner/repo pair — the dispatcher consults `handlesUiRoute` for those
 *  two-segment shapes, so the claims keep the sub-app's reach equal to the
 *  parser's. The deeper tails (`subscriptions`, `watching`) are not in this
 *  slice and stay unclaimed → the engine answers, exactly upstream's
 *  unregistered-route 404. */
export interface NotificationsRoute {
  family:
    | "notifications"
    | "notification-new"
    | "notification-status"
    | "notification-purge"
    | "notification-purge-page"
    | "notification-subscriptions"
    | "notification-watching";
}

/** The wave-9 explore family (pages/explore.tsx): upstream's route group
 *  `m.Group("/explore", …)` (web.go:549-557) — the bare `/explore` redirects
 *  onto `/explore/repos`, which renders the repo search page;
 *  `/explore/users` the user search page; `/explore/organizations` the org
 *  search page (this wave — the census's R01 brief, org.go:17's
 *  Organizations). Claimed by EXACT literal shapes before the owner/repo
 *  parse could read `/explore/repos` as a `{owner: "explore", repo:
 *  "repos"}` repository; the SPEC-0019 M2 code search tail
 *  (`/explore/code` — SPEC-0019 M2's landed page, the navbar's fourth item)
 *  claims beside the literals; every other `/explore/*` tail (sitemap-*,
 *  deeper) stays unclaimed → the engine/parent answer, exactly upstream's
 *  unregistered-route 404. */
export interface ExploreRoute {
  family: "explore-root" | "explore-repos" | "explore-users" | "explore-organizations" | "explore-code";
}

/** Window-2e: the sitemap families (pages/sitemap.ts — upstream web.go:530,
 *  554, 556). */
export interface SitemapRoute {
  family: "home-sitemap" | "explore-repos-sitemap" | "explore-users-sitemap";
  /** The parsed sub-sitemap index (chi's PathParamInt-0→page-1 cascade);
   *  absent on the index family. */
  idx?: number;
}

/** Window-2e: the search aux feeds (pages/search-aux.ts — repo.SearchRepo
 *  web.go:1102 + explore.TopicSearch web.go:564). */
export interface SearchAuxRoute {
  family: "repo-search-aux" | "explore-topic-search-aux" | "repo-migrate";
}

/** The census R14 repo activity page family (pages/repo-activity.tsx):
 *  upstream's `/{username}/{reponame}/activity` group — web.go:1629-1630's
 *  two page GETs over repo.Activity (routers/web/repo/activity.go:22-81),
 *  gated `optSignIn, RepoAssignment, MustBeNotEmpty, RequireUnitReader(code,
 *  issues, pulls, releases)` (web.go:1635-1637 — reading ANY of the four
 *  units admits the group; ours reduces to the visibility read because the
 *  code unit has no toggle). The period segment is OPTIONAL and its switch
 *  has NO 4xx arm (activity.go:30-45): unknowns render the WEEKLY window.
 *  The three chart literals are NOT period values — the R15 chart group's
 *  static routes claim them first (RepoChartRoute below, web.go:1633-1646). */
export interface RepoActivityRoute {
  family: "repo-activity";
  owner: string;
  repo: string;
  /** The RAW {period} path segment (knowns: daily/halfweekly/weekly/
   *  monthly/quarterly/semiyearly/yearly — the loader's switch); `null` =
   *  the bare /activity URL. Unknown segments are kept raw and default to
   *  the weekly arm at the loader, upstream-exact. */
  period: string | null;
}

/** The census R15 chart family (pages/repo-charts.tsx): the three static
 *  chart pages + their `/data` JSON tails — upstream's nested group
 *  (web.go:1633-1646):
 *
 *      m.Group("/contributors",   m.Get("") + m.Get("/data"))
 *      m.Group("/code-frequency", m.Get("") + m.Get("/data"))
 *      m.Group("/recent-commits", m.Get("") + m.Get("/data"))  // same data as code-frequency
 *
 *  registered AHEAD of the /{period} param inside the /activity group, gated
 *  by the group middleware + `reqUnitCodeReader` (web.go:1634 — the code
 *  unit demand; ours reduces to the visibility read, the repo-activity
 *  precedent). Anything past the /data tail (or a non-literal tail deeper
 *  than /{period}) is unclaimed — chi has no such route, the engine 404s. */
export interface RepoChartRoute {
  family: "repo-charts";
  owner: string;
  repo: string;
  kind: RepoChartKind;
  /** `"data"` on the JSON tails; `null` on the three page GETs. */
  tail: "data" | null;
}

/** The census R09-M2 commit-graph family (pages/repo-graph.tsx): upstream
 *  web.go:1738's `m.Get("/graph", repo.Graph)` in a bare group with
 *  `repo.MustBeNotEmpty` (web.go:1737-1744) — NO ref-suffix middleware: the
 *  URL carries no ref, ever. The query arms (mode / hide-pr-refs / branch /
 *  div-only / page) ride the URL, not the path — the family claims the bare
 *  literal only; deeper tails stay unclaimed → the engine's 404, exactly
 *  upstream's unregistered-route answer. */
export interface GraphRoute {
  family: "graph";
  owner: string;
  repo: string;
}

/** The census C1 runs-list family (pages/repo-actions-runs.tsx): upstream
 *  web.go:1606-1608's `m.Get("", actions.List)` in the /actions group —
 *  group middleware `optSignIn, RepoAssignment, repo.MustBeNotEmpty,
 *  reqRepoActionsReader, actions.MustEnableActions` (the READ page needs no
 *  sign-in on a readable repo; the not-empty + unit-flag arms are the
 *  handler's). The family claims the BARE `/actions` literal only — the
 *  sibling tails (`/job_queue` C6's, `/runs/{run}` C2's, `/run`,
 *  `/disable`, `/enable`, `/workflow-dispatch-inputs`,
 *  `/approve-all-checks`, the badge route) stay unclaimed → the engine's
 *  404 until their units land. The `?run_ids=` fragment arm is a QUERY
 *  discriminator (actions.go:632 `Form.Has("run_ids")`), not a path shape. */
export interface RepoActionsRunsRoute {
  family: "repo-actions-runs";
  owner: string;
  repo: string;
}

/** The census C6 job-queue family (pages/repo-actions-queue.tsx): upstream
 *  web.go:1570's `m.Get("/job_queue", actions.JobQueue)` in the /actions
 *  group — the SAME read-group middleware ladder as the runs list (the C1
 *  family's gate note: optSignIn + RepoAssignment + MustBeNotEmpty +
 *  reqRepoActionsReader + MustEnableActions). The `?refresh=1` fragment arm
 *  is a QUERY discriminator (job_queue.go:128 FormBool), not a path shape. */
export interface RepoActionsJobQueueRoute {
  family: "repo-actions-job-queue";
  owner: string;
  repo: string;
}

/** The census C2 run-viewer family (pages/repo-actions-view.tsx): upstream
 *  web.go:1602-1605's three GET+POST pairs — `m.Get`+`m.Post` on
 *  `/runs/{run}`, `/runs/{run}/attempts/{attempt}` and `/runs/{run}/jobs/{job}`
 *  (one View shell / ViewPost JSON pair per shape) — plus web.go:1601's
 *  `m.Post("/runs/{run}/cancel", reqRepoActionsWriter, actions.Cancel)` (the
 *  census C5-adjacent arm; the rerun/rerun-failed tails are
 *  emitter-dependent and stay unclaimed per the census C5 flag). The same
 *  read-group middleware ladder gates every shape (the C1 family's note:
 *  optSignIn + RepoAssignment + MustBeNotEmpty + reqRepoActionsReader +
 *  MustEnableActions). The segments claim for ANY single-segment value (chi
 *  params; PathParamInt64 parses junk to 0 — the loader's 404/absent arms),
 *  the exact literal tails only; every deeper tail and the remaining
 *  siblings (`/run`, `/disable`, `/enable`, `/workflow-dispatch-inputs`,
 *  `/approve-all-checks`, `/runs/{run}/rerun*`, `/runs/{run}/workflow`,
 *  `/runs/{run}/logs`, the artifacts tails) stay unclaimed → the engine's
 *  404 until their units land. */
export interface RepoActionsRunViewRoute {
  family: "actions-run-view" | "actions-run-cancel" | "actions-run-job-logs" | "actions-run-workflow";
  owner: string;
  repo: string;
  /** The raw {run} segment: the run row id, the legacy per-repo run index,
   *  or the "latest" literal (junk parses to the loader's 404). */
  run: string;
  /** The raw {attempt} segment (the attempts shape only). */
  attempt?: string;
  /** The raw {job} segment (the jobs shape only). */
  job?: string;
}

/** The census C4 artifacts preview subtree (pages/repo-actions-artifacts.tsx
 *  — upstream web.go:1602-1603's `m.Get("/artifacts/{artifact_id}/preview",
 *  ...)` + the `/*` tail inside the /actions group). The {id} claims digits
 *  only (the house PathParamInt64 idiom — "007" parses as 7); the tail
 *  beyond /preview/ is decoded per segment and rejoined with "/" separators
 *  (pathEscapeSegments keeps them). The siblings (`/runs/{run}/artifacts/
 *  {name}`'s download zip-compose + delete, `/artifacts/{id}` alone) stay
 *  unclaimed → the engine's 404 until their units land. */
export interface RepoActionsArtifactPreviewRoute {
  family: "actions-artifact-preview";
  owner: string;
  repo: string;
  artifactId: number;
  /** The decoded /preview tail ("" on the bare URL). */
  previewPath: string;
}

/** The C4 artifacts preview SIGNED raw family (root scope, upstream's
 *  `/-/actions/artifacts/{id}/{expires}/{signature}[/...]` — view_artifact.
 *  go:392-484): the HMAC IS the auth, no session arm, so no viewer gate at
 *  the route. The {id}/{expires} segments claim digits only; {signature}
 *  is the base64url segment verbatim; the tail decodes per segment with
 *  "/" separators rejoined. Every other /-/actions/* tail stays unclaimed
 *  → the engine's 404. */
export interface ActionsArtifactPreviewRawRoute {
  family: "actions-artifact-preview-raw";
  artifactId: number;
  expires: number;
  /** The path's base64url signature segment (compared over encoded bytes). */
  signature: string;
  /** The decoded route tail ("" at the bare signed root). */
  previewPath: string;
}

/** The census C4 remainder: the runs-artifact download + delete family
 *  (pages/repo-actions-artifacts-download.ts — upstream web.go:1595-1596).
 *  One family for BOTH methods: the GET is the zip-compose/v4 stream, the
 *  DELETE is the writer-gated pending-deletion mark. The {run} segment
 *  claims ANY value (chi params — resolveRunByPath's loader arms);
 *  {artifact_name} is ONE decoded segment (url.PathEscape composes it
 *  upstream). */
export interface RepoActionsRunArtifactRoute {
  family: "actions-run-artifact";
  owner: string;
  repo: string;
  run: string;
  artifactName: string;
}

/** The F-row tail: the workflow BADGE family (pages/repo-actions-badge.ts —
 *  upstream web.go:1606's `/workflows/{workflow_name}/badge.svg` inside
 *  the /actions group). The {workflow_name} segment rides raw (chi's own
 *  param; the resolver tolerates both workflow-id spellings). */
export interface RepoActionsWorkflowBadgeRoute {
  family: "repo-actions-workflow-badge";
  owner: string;
  repo: string;
  workflowName: string;
}

/** The F-row tail: the dispatch-modal inputs FRAGMENT (pages/
 *  repo-actions-dispatch-inputs.tsx — upstream web.go:1572's
 *  `/workflow-dispatch-inputs` aux GET, an HTML fragment the official
 *  bundle's data-fetch-sync swaps into the modal). GET-only, writer-gated
 *  per upstream's reqRepoActionsWriter on the route. */
export interface RepoActionsDispatchInputsRoute {
  family: "repo-actions-dispatch-inputs";
  owner: string;
  repo: string;
}


/** Window-2e B2: the repo-scoped aux feeds + fragments (issues-search-aux,
 *  issue-content-fragments, pull-merge-box, compare-feeds,
 *  pull-files-single-commit, activity-author-data). */
export interface IssueAuxRoute {
  family:
    | "issues-search-aux"
    | "issues-suggestions-aux"
    | "issue-info"
    | "issue-attachments"
    | "issue-content-overview"
    | "issue-content-history-list"
    | "issue-content-history-detail"
    | "issue-content-history-soft-delete"
    | "issue-attachments-alias"
    | "pull-merge-box"
    | "pull-files-range"
    | "pull-commit-files"
    | "activity-author-data"
    | "comment-attachments"
    | "compare-feed";
  owner: string;
  repo: string;
  /** The issue/PR index (the fragment families). */
  index?: number;
  /** issues vs pulls (the shared fragment arms). */
  urlKind?: "issues" | "pulls";
  /** The raw tail segment (files-range pair, single-commit sha,
   *  attachments uuid, activity period). */
  segment?: string;
  /** The feed extension (the compare-feed family). */
  ext?: "diff" | "patch";
}

/** The wave-12 user settings family (pages/user-settings.tsx): upstream's
 *  literal `/user/settings` (routers/web/shared/user settings header +
 *  user/settings/profile.tmpl — web.go's /user group registers ahead of the
 *  dynamic pairs, so upstream shadows a `{user: "user", repo: "settings"}`
 *  repository identically; "user" is additionally a reserved username,
 *  orgs.ts's RESERVED_USERNAMES port). The deeper settings tails (account,
 *  security, applications, keys, …) stay unclaimed → the engine's 404: no
 *  landed surfaces. */
export interface UserSettingsRoute {
  family: "user-settings";
}

/** Window-2c: the admin family (pages/admin-dashboard.tsx +
 *  pages/admin-monitor.tsx + the wave's users/orgs/repos pages — upstream's
 *  /-/admin group). The census R18 (a) arms extend the family union
 *  additively: emails / hooks / badges / applications, SPEC-0018 §3.1's
 *  notices arm and §3.2's config summary (each module's header carries its
 *  mount record; the remaining upstream arms stay unclaimed — auths is the
 *  census's remaining (b) class, packages/actions the (c) gate). */
export interface AdminRoute {
  family:
    | "admin-dashboard"
    | "admin-monitor"
    | "admin-users"
    | "admin-orgs"
    | "admin-repos"
    | "admin-packages"
    | "admin-emails"
    | "admin-emails-activate"
    | "admin-emails-delete"
    | "admin-hooks"
    | "admin-hooks-delete"
    | "admin-badges"
    | "admin-badge-new"
    | "admin-badge-view"
    | "admin-badge-edit"
    | "admin-badge-delete"
    | "admin-badge-users"
    | "admin-badge-users-delete"
    | "admin-applications"
    | "admin-application-create"
    | "admin-application-delete"
    | "admin-config"
    | "admin-notices"
    | "admin-notices-delete"
    | "admin-notices-empty"
    // The census C6 arm: the admin JOB QUEUE page (pages/repo-actions-queue.tsx
    // — web.go:904's `GET /actions/job_queue` shared_actions.JobQueue inside
    // the /-/admin group's /actions group), plus the group's RUNNERS and
    // VARIABLES pages and write arms (pages/admin-actions-runners.tsx /
    // admin-actions-variables.tsx — web.go:898-902's addSettingsRunnersRoutes
    // + addSettingsVariablesRoutes + the bare group's ./actions/runners
    // LocationRedirect). The scoped-workflows tail (web.go:903) stays
    // unclaimed — its action_scoped_workflow_source store has no substrate
    // (the module's documented reduction, the dead-link rule).
    | "admin-actions-job-queue"
    | "admin-actions-redirect"
    | "admin-actions-runners"
    | "admin-actions-runners-token-reset"
    | "admin-actions-runners-edit"
    | "admin-actions-runners-update"
    | "admin-actions-runners-delete"
    | "admin-actions-runners-bulk"
    | "admin-actions-variables"
    | "admin-actions-variables-new"
    | "admin-actions-variables-edit"
    | "admin-actions-variables-delete";
  /** The monitor page (stats/cron/queue/stacktrace → the module's
   *  AdminMonitorPage union); absent on the dashboard family and the three
   *  listing families. */
  page?: "stats" | "cron" | "queue" | "trace";
  /** The decoded {badge_slug} path param (the badges slug families —
   *  upstream chi's own param; a junk-encoding segment never claims). */
  badgeSlug?: string;
  /** The positive-integer {id} (the application-delete family — the landed
   *  PathParamInt64 posture; "007" parses as 7). */
  applicationId?: number;
  /** The positive-integer {id} for the admin actions families — the
   *  runners edit/update/delete combos and the variables edit/delete
   *  combos (digits-only claims, the same PathParamInt64 posture). */
  id?: number;
}

/** Window-2a: the user-settings tab families (the two-stage module wave —
 *  each tab module's header carries its route recipe; upstream's
 *  reqSignIn /user/settings/* groups, web.go:646-746). Same literal posture
 *  as the bare claim below: "user" is reserved and the /user group
 *  registers ahead of the dynamic pairs. */
export interface UserSettingsTabRoute {
  family:
    | "user-settings-appearance"
    | "user-settings-appearance-theme"
    | "user-settings-appearance-language"
    | "user-settings-security"
    | "user-settings-secrets"
    | "user-settings-secrets-delete"
    | "user-settings-variables"
    | "user-settings-variables-new"
    | "user-settings-variables-edit"
    | "user-settings-variables-delete"
    | "user-settings-hooks"
    | "user-settings-hook-detail"
    | "user-settings-hook-delete"
    | "user-settings-keys"
    | "user-settings-keys-delete"
    | "user-settings-applications"
    | "user-settings-applications-delete"
    | "user-settings-account"
    | "user-settings-account-email"
    | "user-settings-account-email-delete"
    | "user-settings-account-delete"
    | "user-settings-notifications"
    | "user-settings-notifications-email"
    | "user-settings-notifications-actions"
    | "user-settings-organizations"
    | "user-settings-organizations-leave"
    | "user-settings-repos";
  /** The numeric path segment (hook/variable id), already parsed. */
  id: number | null;
}

/** The wave-12 org teams families (pages/org-teams.tsx): upstream's
 *  `/{org}/teams` group (web.go:993-1013) at the landed API shapes — the
 *  list, the detail slice (upstream links by team name; the slice follows
 *  the landed /teams/{id} read arms), and the create form. The literal
 *  `teams` second segment claims the shapes before the repo parse could
 *  read them as a repository named "teams" — upstream shadows such a repo
 *  identically (web.go:993 registers ahead of :1292's
 *  `/{username}/{reponame}`). The deeper tails (`/{id}/repositories`,
 *  `/{id}/edit`, `/{id}/delete`, the `/action/*` writes) stay unclaimed →
 *  the engine's 404. The census R19 wave adds the NAME CARRIER on the
 *  detail family: a non-numeric `/{team}` segment claims the same detail
 *  arm resolved case-folded through the lower_name (upstream's EqualFold
 *  walk, services/context/org.go:213-218; a miss 404-shells, org.go:214-
 *  218 — upstream answers its 404 page for any team param, so the segment
 *  claim is upstream-shaped), while the five-segment edit/delete tails
 *  keep their positive-integer-only claims (the wave-49 shapes). */
export interface OrgTeamsRoute {
  family: "org-teams" | "org-team-new" | "org-team-detail";
  /** Decoded org segment. */
  owner: string;
  /** The team id (the detail family's numeric carrier). */
  id?: number;
  /** The team name (the detail family's R19 name carrier — decoded,
   *  resolved case-folded against lower_name at load). */
  name?: string;
}

/** The wave-14 org labels management families (pages/org-labels.tsx): the
 *  brief's literal `/{org}/labels` page plus upstream's three POST segments
 *  (`/labels/new`, `/labels/edit`, `/labels/delete` — web.go:1043-1048's
 *  writes; the brief's literal claims the `labels` second segment before the
 *  repo parse, the teams precedent). The `/labels/initialize` template
 *  loader and any deeper tail stay unclaimed → the engine's 404. */
export interface OrgLabelsRoute {
  family: "org-labels" | "org-label-new" | "org-label-edit" | "org-label-delete";
  /** Decoded org segment. */
  owner: string;
}

/** The wave-49 org settings + team-edit families (pages/org-settings.tsx):
 *  upstream's require-owner `/{org}` group — web.go:1011's
 *  `{team}/edit` GET+POST combo and `{team}/delete` POST, and web.go:1017-1092's
 *  `/settings` group: the options combo (GET+POST), the avatar write pair,
 *  and the danger-zone POST arms (rename/delete/visibility — upstream's
 *  literal segments; the hooks/applications/labels/packages/actions/
 *  blocked_users/audit_logs tabs are separate pages this wave does not
 *  claim). The `teams` and `settings` second segments claim their shapes
 *  before the repo parse could read them as repositories named "teams"/
 *  "settings" — upstream shadows such repos identically (the org groups
 *  register ahead of :1292's `/{username}/{reponame}`). The team id shapes
 *  claim positive integers only (the org-teams detail precedent — "007"
 *  parses as 7; junk segments stay unclaimed → the engine's 404, upstream's
 *  PathParamInt64-zero ServerError arm). */
export interface OrgSettingsRoute {
  family:
    | "org-settings" // GET+POST /{org}/settings (the options combo)
    | "org-settings-avatar" // POST /{org}/settings/avatar
    | "org-settings-avatar-delete" // POST /{org}/settings/avatar/delete
    | "org-settings-rename" // POST /{org}/settings/rename
    | "org-settings-delete" // POST /{org}/settings/delete
    | "org-settings-visibility" // POST /{org}/settings/visibility
    | "org-settings-hooks" // GET+POST /{org}/settings/hooks (the webhooks list + add form — wave 53)
    | "org-settings-hook-detail" // GET+POST /{org}/settings/hooks/{id} (the edit page — wave 53)
    | "org-settings-hook-delete" // POST /{org}/settings/hooks/{id}/delete (wave 53)
    | "org-settings-blocked" // GET+POST /{org}/settings/blocked_users (window-2b)
    | "org-settings-applications" // GET /{org}/settings/applications (the R20-a oauth2 list)
    | "org-settings-applications-create" // POST /{org}/settings/applications/oauth2 (the R20-a create)
    | "org-settings-applications-delete" // POST /{org}/settings/applications/oauth2/{id}/delete (the R20-a delete)
    | "org-settings-audit-logs" // GET /{org}/settings/audit_logs (the R20 +audit arm / R13 org mount — GET only upstream, web.go:1069)
    | "org-actions-secrets" // GET+POST /{org}/settings/actions/secrets (window-2b)
    | "org-actions-secrets-delete" // POST .../secrets/delete (window-2b)
    | "org-actions-variables" // GET /{org}/settings/actions/variables (window-2b)
    | "org-actions-variables-new" // POST .../variables/new (window-2b)
    | "org-actions-variables-edit" // POST .../variables/{id}/edit (window-2b)
    | "org-actions-variables-delete" // POST .../variables/{id}/delete (window-2b)
    | "org-actions-runners" // GET /{org}/settings/actions/runners (the census C7 org arm)
    | "org-actions-runners-token-reset" // POST .../runners/reset_registration_token
    | "org-actions-runners-edit" // GET+POST .../runners/{id} (page + the description update)
    | "org-actions-runners-update" // POST .../runners/{id}/update-runner
    | "org-actions-runners-delete" // POST .../runners/{id}/delete
    | "org-team-edit" // GET+POST /{org}/teams/{id}/edit
    | "org-team-delete" // POST /{org}/teams/{id}/delete
  ;
  /** Decoded org segment. */
  owner: string;
  /** The team id (the team-edit/delete families) or hook id (the org
   * hook-detail/delete families — wave 53). */
  id?: number;
}

/** The census R06 org dashboard family (pages/org-dashboard.tsx): upstream's
 *  `/org/{org}/dashboard` + `/org/{org}/dashboard/{team}` literals
 *  (web.go:982-985 — `user.Dashboard` under
 *  `OrgAssignment{RequireMember: true, RequireTeamMember: true}`, the
 *  MEMBER-ONLY posture the page keeps: anonymous AND non-members 404-shell,
 *  upstream's RequireMember NotFound with no login redirect). The literal
 *  `org` first segment and `dashboard` third claim the shapes before the
 *  repo parse could read them (the org-members exact-literal posture —
 *  upstream's /org group registers ahead of :1292's `/{username}/{reponame}`,
 *  and the "org" owner name is create-time reserved besides). The {team}
 *  tail is any decodable segment: upstream resolves it case-folded against
 *  the visible teams' lower names and 404s the miss (org.go:213-232, the
 *  RequireTeamMember arm included). The heatmap tails
 *  (`/dashboard/-/heatmap[/{team}]` — R03) and every deeper shape stay
 *  unclaimed → the engine's 404. */
export interface OrgDashboardRoute {
  family: "org-dashboard";
  /** Decoded org segment. */
  owner: string;
  /** The decoded team-name tail (the `/{team}` arm — resolved case-folded
   *  against the org's teams at load). */
  team?: string;
}

/** The wave-13 compare family (pages/compare.tsx): upstream's
 *  `m.Get("/compare")` + the `/compare/*` path group (web.go:1307-1315) —
 *  the bare URL (both sides the default branch) and the full
 *  ParseCompareRouterParam grammar (routers/common/compare.go:74-102): the
 *  FIRST `...` splits, else the first `..` (DirectComparison — the two-dot
 *  arm, landed window-crosscompare: the feeds module's own
 *  parseCompareBaseHead semantics), else the whole tail is the head
 *  (upstream's single-ref family); an empty side falls back to the default
 *  branch at load. The head part carries the fork forms (parseHead,
 *  compare.go:36-46 — grammar forms 2/3/5/6): `{owner}:{ref}` and
 *  `{owner}/{repo}:{ref}` name the head REPO (the fork-edge resolution
 *  landed with the API's fork-PR flow); the BASE part never carries a fork
 *  form upstream (parseHead is head-only) — a colon there is an
 *  unresolvable ref name → the 404 shell. A `..` left inside a side is the
 *  same 404 class (refnames can never carry `..`).
 *  The POST on the same tail is the new-PR write
 *  (CompareAndPullRequestPost — the form lives INLINE on the compare page). */
export interface CompareRoute {
  family: "compare";
  owner: string;
  repo: string;
  /** The base side; `null` = the bare/empty form → the default branch. */
  base: string | null;
  /** The head side; `null` = the bare/empty form → the default branch. */
  head: string | null;
  /** The URL's separator (upstream CompareRouterReq.CompareSeparator /
   *  CompareInfo.CompareSeparator): `...` diffs from the merge base,
   *  `..` diffs the two tips (DirectComparison). */
  separator: "..." | "..";
  /** The head-side fork form's owner (parseHead); `null` = the same-repo
   *  head (the owner segment omitted). */
  headOwner: string | null;
  /** The fork form's explicit repo name (`{owner}/{repo}:{ref}` form);
   *  `null` = the bare `{owner}:{ref}` form (the fork edge decides). */
  headRepoName: string | null;
}

/** Top-level single-segment paths this router must never claim: the session
 *  router's literals (registered on the SAME parent app AFTER this sub-app,
 *  so a dynamic `/:owner` registration would shadow them — SPEC-0010 §2.1)
 *  and the dispatcher's own `/healthz`. Upstream reserves several of these
 *  names at create time for the same reason. The wave-7 owner-home family
 *  (user profiles AND org homes share the shape) extends wave 6's label
 *  regex verbatim — it admits every name except these literals. */
const TOP_LEVEL_EXCLUDED = new Set(["login", "logout", "healthz"]);

/** Everything `parseUiRoute` can return; `UiRoute` remains the slice-1 view
 *  render.tsx consumes. */
export type ParsedUiRoute =
  | UiRoute
  | TreeRoute
  | IssuesListRoute
  | IssueDetailRoute
  | IssueNewRoute
  | SettingsRoute
  | IssueCommentRoute
  | IssueLabelsRoute
  | PullFilesRoute
  | PullCommitsRoute
  | PullReviewRoute
  | MilestonesRoute
  | MilestoneNewRoute
  | OwnerHomeRoute
  | UserFeedRoute
  | IssueAuxRoute
  | GlobalInboxRoute
  | WikiRoute
  | FileEditorRoute
  | BlameRoute
  | RepoSearchRoute
  | RepoActivityRoute
  | RepoChartRoute
  | GraphRoute
  | RepoActionsRunsRoute
  | RepoActionsJobQueueRoute
  | RepoActionsRunViewRoute
  | RepoActionsArtifactPreviewRoute
  | ActionsArtifactPreviewRawRoute
  | RepoActionsRunArtifactRoute
  | RepoActionsWorkflowBadgeRoute
  | RepoActionsDispatchInputsRoute
  | SiteHomeRoute
  | ExploreRoute
  | NotificationsRoute
  | UserSettingsRoute
  | UserSettingsTabRoute
  | AdminRoute
  | SitemapRoute
  | SearchAuxRoute
  | OrgTeamsRoute
  | OrgLabelsRoute
  | OrgSettingsRoute
  | OrgDashboardRoute
  | CompareRoute
  | BranchesRoute
  | CommitViewRoute
  | ReleasesRoute
  | RepoCreateRoute
  | OrgCreateRoute
  | OrgMembersRoute
  | OrgRepositoriesRoute
  | OwnerPackagesRoute
  | RepoPackagesRoute
  | OwnerProjectsRoute
  | OwnerProjectBoardRoute
  | RepoProjectsRoute
  | RepoSocialRoute
  | SettingsCollaborationRoute
  | TagsRoute
  | RepoLabelsRoute
  | MilestoneDetailRoute
  | MilestoneEditRoute
  | RepoForkRoute
  | DiffPatchRoute
  | RepoArchiveRoute
  | CommitContainedRefsRoute
  | BlobRedirectRoute
  | TreeListAuxRoute
  | TreeViewAuxRoute
  | BranchesListAuxRoute
  | ReleaseDownloadRoute
  | ReleasesFeedRoute
  | TagsFeedRoute
  | RenderFileRoute
  | LastCommitRoute
  | BlobExcerptRoute
  | WikiRawRoute
  | RawMediaRoute
  | OwnerHeatmapRoute
  | UserCodeSearchRoute
  | OrgInboxRoute;


/**
 * Parse a repo-scoped pathname into a UI route, or `null` when the path is
 * not a UI family (→ the dispatcher keeps the engine/gate ownership).
 *
 * Segment handling mirrors `parseGitHttpRoute` (src/git-http/parse.ts):
 * percent-decoding per segment (undecodable → not ours; the engine 404s
 * those), exactly one trailing `.git` trimmed after decoding, and a
 * structural pre-filter — an empty segment anywhere (double slashes,
 * including the never-emitted `//` tails) makes the path not ours.
 */
export function parseUiRoute(pathname: string): ParsedUiRoute | null {
  if (!pathname.startsWith("/")) return null;
  // §4.13: the router 301s trailing-slash URLs to the canonical form; the
  // parser classifies the trimmed shape so the dispatcher admits them.
  const trimmed = pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  const raw = trimmed.split("/");
  // The wave-9 site root (pages/dashboard.tsx — upstream Home): the
  // dashboard for a signed-in viewer, the landing page for anonymous. The
  // trailing-slash form canonicalizes to this shape through the trim above.
  if (raw.length === 1 && raw[0] === "") return { family: "site-home" };
  if (raw.length < 2) return null; // need at least /owner
  if (raw.slice(1).some((segment) => segment === "")) return null;

  // Window-2e: the sitemap literals (pages/sitemap.ts) — EXACT shapes
  // BEFORE the owner/repo parse (else /explore/repos/sitemap-1.xml parses
  // owner=explore). Non-sitemap tails under explore/{repos,users}/ stay
  // unclaimed → the engine's 404.
  if (raw.length === 2 && raw[1] === "sitemap.xml") return { family: "home-sitemap" };
  if (raw.length === 4 && raw[1] === "explore" && (raw[2] === "repos" || raw[2] === "users")) {
    const idx = parseSitemapIdx(raw[3] as string);
    if (idx !== null) {
      return { family: raw[2] === "repos" ? "explore-repos-sitemap" : "explore-users-sitemap", idx };
    }
    return null;
  }

  // The wave-9 explore family (pages/explore.tsx — upstream web.go:549-556):
  // EXACT literal shapes claimed before the owner/repo parse could read
  // `/explore/repos` as a repository. The SPEC-0019 M2 code search tail
  // claims beside the literals (pages/explore-code.tsx — the navbar's
  // fourth item, the tab's dead-link reason expired when its page landed).
  // Any other tail (sitemap-*, deeper) stays unclaimed — the engine/parent
  // 404s it, exactly like upstream's unregistered routes. A same-named user
  // namespace (`/EXPLORE`, or `/e%78plore`'s decoded form) keeps the
  // owner-home family — the literals bind case-sensitively, like the chi
  // patterns.
  if (raw[1] === "explore") {
    if (raw.length === 2) return { family: "explore-root" };
    if (raw.length === 3 && raw[2] === "repos") return { family: "explore-repos" };
    if (raw.length === 3 && raw[2] === "users") return { family: "explore-users" };
    // The org search page (this wave — upstream web.go:557's literal,
    // org.go:17's Organizations over the shared tplExploreUsers template).
    if (raw.length === 3 && raw[2] === "organizations") return { family: "explore-organizations" };
    // The SPEC-0019 M2 code search page (upstream web.go:558's literal,
    // code.go's explore.Code over the federation seeds).
    if (raw.length === 3 && raw[2] === "code") return { family: "explore-code" };
    // Window-2e: the topic search aux feed (pages/search-aux.ts — upstream
    // explore.TopicSearch, web.go:564, optSignIn).
    if (raw.length === 4 && raw[2] === "topics" && raw[3] === "search") {
      return { family: "explore-topic-search-aux" };
    }
    return null;
  }

  // The wave-10 notifications family (pages/notifications.tsx — upstream
  // web.go:1784-1791): the same exact-literal posture as explore above. The
  // two-segment POST tails MUST be claimed here — the dispatcher consults
  // handlesUiRoute for two-segment paths, and the unclaimed shape would read
  // as an owner/repo pair and fall to the git gate.
  if (raw[1] === "notifications") {
    if (raw.length === 2) return { family: "notifications" };
    if (raw.length === 3 && raw[2] === "new") return { family: "notification-new" };
    if (raw.length === 3 && raw[2] === "status") return { family: "notification-status" };
    if (raw.length === 3 && raw[2] === "purge") return { family: "notification-purge" };
    // The purge-page write (matrix-14's recipe, notification.go:207-218 —
    // POST-only; the GET twin answers the methodNotAllowed arm).
    if (raw.length === 3 && raw[2] === "purge-page") return { family: "notification-purge-page" };
    // Window-2e C3b: the subscriptions tails (web.go:1786-1787, GET-only).
    if (raw.length === 3 && raw[2] === "subscriptions") return { family: "notification-subscriptions" };
    if (raw.length === 3 && raw[2] === "watching") return { family: "notification-watching" };
    return null;
  }

  // The wave-12 user settings literal (pages/user-settings.tsx — upstream's
  // reqSignIn /user/settings): claimed before the owner/repo parse could
  // read it as a repository named "settings" under a user named "user" (the
  // notifications precedent; upstream's /user group registers ahead of the
  // dynamic pairs, and "user" is a reserved username besides). Window-2a
  // extends the claim down the tab tails — each shape maps to a committed
  // two-stage module's handoff recipe; every OTHER tail stays unclaimed →
  // the engine's 404 (no landed surface).
  if (raw[1] === "user" && raw[2] === "settings") {
    const tail = raw.slice(3);
    const numericId = (value: string | undefined): number | null =>
      value !== undefined && /^\d+$/.test(value) ? Number.parseInt(value, 10) : null;
    if (tail.length === 0) return { family: "user-settings" };
    if (tail.length === 1 && tail[0] === "appearance") return { family: "user-settings-appearance", id: null };
    if (tail.length === 2 && tail[0] === "appearance" && tail[1] === "theme") {
      return { family: "user-settings-appearance-theme", id: null };
    }
    if (tail.length === 2 && tail[0] === "appearance" && tail[1] === "language") {
      return { family: "user-settings-appearance-language", id: null };
    }
    if (tail.length === 1 && tail[0] === "security") return { family: "user-settings-security", id: null };
    if (tail.length === 2 && tail[0] === "actions" && tail[1] === "secrets") {
      return { family: "user-settings-secrets", id: null };
    }
    if (tail.length === 3 && tail[0] === "actions" && tail[1] === "secrets" && tail[2] === "delete") {
      return { family: "user-settings-secrets-delete", id: null };
    }
    if (tail.length === 2 && tail[0] === "actions" && tail[1] === "variables") {
      return { family: "user-settings-variables", id: null };
    }
    if (tail.length === 3 && tail[0] === "actions" && tail[1] === "variables" && tail[2] === "new") {
      return { family: "user-settings-variables-new", id: null };
    }
    if (tail.length === 4 && tail[0] === "actions" && tail[1] === "variables" && tail[3] === "edit") {
      const id = numericId(tail[2]);
      return id === null ? null : { family: "user-settings-variables-edit", id };
    }
    if (tail.length === 4 && tail[0] === "actions" && tail[1] === "variables" && tail[3] === "delete") {
      const id = numericId(tail[2]);
      return id === null ? null : { family: "user-settings-variables-delete", id };
    }
    if (tail.length === 1 && tail[0] === "hooks") return { family: "user-settings-hooks", id: null };
    if (tail.length === 2) {
      const id = numericId(tail[1]);
      if (id !== null) return { family: "user-settings-hook-detail", id };
    }
    if (tail.length === 3 && tail[2] === "delete") {
      const id = numericId(tail[1]);
      if (id !== null) return { family: "user-settings-hook-delete", id };
    }
    if (tail.length === 1 && tail[0] === "keys") return { family: "user-settings-keys", id: null };
    if (tail.length === 2 && tail[0] === "keys" && tail[1] === "delete") {
      return { family: "user-settings-keys-delete", id: null };
    }
    if (tail.length === 1 && tail[0] === "applications") return { family: "user-settings-applications", id: null };
    if (tail.length === 2 && tail[0] === "applications" && tail[1] === "delete") {
      return { family: "user-settings-applications-delete", id: null };
    }
    // The account tab (navbar.tmpl:7-11; upstream EmailPost/DeleteEmail/
    // DeleteAccount over the landed email + PAT stores).
    if (tail.length === 1 && tail[0] === "account") return { family: "user-settings-account", id: null };
    if (tail.length === 2 && tail[0] === "account" && tail[1] === "email") {
      return { family: "user-settings-account-email", id: null };
    }
    if (tail.length === 3 && tail[0] === "account" && tail[1] === "email" && tail[2] === "delete") {
      return { family: "user-settings-account-email-delete", id: null };
    }
    if (tail.length === 2 && tail[0] === "account" && tail[1] === "delete") {
      return { family: "user-settings-account-delete", id: null };
    }
    // The notifications tab (navbar.tmpl:12-16; the two preference POSTs —
    // NO EnableNotifyMail/Actions-enabled 404 arms, both reduce to
    // always-mounted, SPEC §3).
    if (tail.length === 1 && tail[0] === "notifications") return { family: "user-settings-notifications", id: null };
    if (tail.length === 2 && tail[0] === "notifications" && tail[1] === "email") {
      return { family: "user-settings-notifications-email", id: null };
    }
    if (tail.length === 2 && tail[0] === "notifications" && tail[1] === "actions") {
      return { family: "user-settings-notifications-actions", id: null };
    }
    // The repos tab (web.go:734 — GET only; the unadopted POST is
    // structurally absent in the R2/DO-behind-D1 model, the module header).
    if (tail.length === 1 && tail[0] === "repos") return { family: "user-settings-repos", id: null };
    // The orgs tab is SINGULAR on the wire (web.go:740 m.Get("/organization",
    // …) serves the plural template — the module's premise correction).
    if (tail.length === 1 && tail[0] === "organization") return { family: "user-settings-organizations", id: null };
    if (tail.length === 2 && tail[0] === "organization" && tail[1] === "leave") {
      return { family: "user-settings-organizations-leave", id: null };
    }
    return null;
  }

  // The wave-19 creation literals (pages/repo-create.tsx + pages/
  // org-create.tsx — upstream's reqSignIn /repo/create + /org/create
  // groups, web.go:1094-1098 + 970-974): the same exact-literal posture as
  // user-settings above. Upstream's /repo and /org groups register ahead of
  // the dynamic pairs too, so a repository named "create" under an owner
  // named "repo" or "org" is shadowed identically (and both names are
  // upstream-reserved at create time besides). Every other /repo|org/*
  // tail stays unclaimed → the engine's 404 (upstream's unregistered-route
  // answer for this slice).
  if (raw.length === 3 && raw[1] === "repo" && raw[2] === "create") {
    return { family: "repo-create" };
  }
  // Window-2e: the repo search aux feed (pages/search-aux.ts — upstream
  // repo.SearchRepo, web.go:1102, reqSignIn): the exact-literal posture
  // beside repo-create.
  if (raw.length === 3 && raw[1] === "repo" && raw[2] === "search") {
    return { family: "repo-search-aux" };
  }
  // Window-2e C3: the migration page (pages/repo-migrate.tsx — upstream's
  // reqSignIn /repo/migrate, web.go:1094).
  if (raw.length === 3 && raw[1] === "repo" && raw[2] === "migrate") {
    return { family: "repo-migrate" };
  }
  if (raw.length === 3 && raw[1] === "org" && raw[2] === "create") {
    return { family: "org-create" };
  }

  // Window-2c: the ADMIN literal family (pages/admin-dashboard.tsx +
  // pages/admin-monitor.tsx + the wave's users/orgs/repos pages —
  // upstream's /-/admin group, web.go:779-813,
  // behind verifyAuthWithOptionsWeb(SignInRequired+AdminRequired)): the
  // top-level `/-` namespace is otherwise unclaimed (a repo cannot be named
  // "-"), so the exact shapes claim ahead of the dynamic owner/repo parse.
  // Only the landed pages claim: /-/admin (dashboard GET+POST), the four
  // monitor pages (+ cron run POST), the three listing literals
  // (users/orgs/repos — static-before-dynamic: any future numeric
  // `/-/admin/users/{id}` arm claims AFTER these; the tail-length guards
  // keep them unambiguous), and the census-R18 (a) arms (emails / hooks /
  // badges / applications — each module's mount record; the slug families
  // decode the {badge_slug} segment, the application delete claims the
  // positive-integer {id}). Every other /-/* tail stays unclaimed
  // → the engine's 404 (upstream's unregistered-route answer).
  // The C4 artifacts preview SIGNED raw family (pages/repo-actions-artifacts.
  // tsx — upstream's /-/actions/artifacts/{id}/{expires}/{signature}[/...]
  // route, view_artifact.go:392-484): the HMAC itself is the auth (no
  // session arm). The {id}/{expires} segments claim digits only (the house
  // idiom — junk stays engine-owned); {signature} is the base64url segment
  // verbatim (no percent-decode ambiguity); the tail decodes per segment
  // with "/" separators rejoined. Every other /-/actions/* tail stays
  // unclaimed → the engine's 404.
  if (
    raw[1] === "-" &&
    raw[2] === "actions" &&
    raw[3] === "artifacts" &&
    raw.length >= 7 &&
    /^\d+$/.test(raw[4] as string) &&
    /^\d+$/.test(raw[5] as string)
  ) {
    const tailSegments = raw.slice(7);
    let previewPath = "";
    if (tailSegments.length > 0) {
      const tail: string[] = [];
      for (const segment of tailSegments) {
        try {
          tail.push(decodeURIComponent(segment));
        } catch {
          return null;
        }
      }
      previewPath = tail.join("/");
    }
    return {
      family: "actions-artifact-preview-raw",
      artifactId: Number.parseInt(raw[4] as string, 10),
      expires: Number.parseInt(raw[5] as string, 10),
      signature: raw[6] as string,
      previewPath,
    };
  }
  if (raw[1] === "-" && raw[2] === "admin") {
    const tail = raw.slice(3);
    if (tail.length === 0) return { family: "admin-dashboard" };
    if (tail.length === 1 && tail[0] === "users") return { family: "admin-users" };
    if (tail.length === 1 && tail[0] === "orgs") return { family: "admin-orgs" };
    if (tail.length === 1 && tail[0] === "repos") return { family: "admin-repos" };
    // The tick-18 packages arm (pages/admin-packages.tsx — web.go:852-858's
    // /packages group): the bare list GET only. The group's delete/cleanup
    // POSTs stay unclaimed — unlanded writes (the module's dead-link note),
    // the engine's 404; the group's `packagesEnabled` qualifier rides the
    // handler's ctx.packagesEnabled arm, not the parse.
    if (tail.length === 1 && tail[0] === "packages") return { family: "admin-packages" };
    // The R18 emails arm (web.go:821-824's /emails group): the list GET and
    // the two write POSTs (the module's plain-form arms).
    if (tail.length === 1 && tail[0] === "emails") return { family: "admin-emails" };
    if (tail.length === 2 && tail[0] === "emails" && tail[1] === "activate") return { family: "admin-emails-activate" };
    if (tail.length === 2 && tail[0] === "emails" && tail[1] === "delete") return { family: "admin-emails-delete" };
    // The R18 hooks arm (web.go:836-846's /hooks group): the two-list GET
    // + the delete POST; the /{id} edit and /{default-hooks|system-hooks}
    // add families stay unclaimed (unlanded — the module's dead-link note).
    if (tail.length === 1 && tail[0] === "hooks") return { family: "admin-hooks" };
    if (tail.length === 2 && tail[0] === "hooks" && tail[1] === "delete") return { family: "admin-hooks-delete" };
    // The R18 badges arm (web.go:815-824's /badges group): the catalog
    // list, the new combo, the slug param families (view/edit-combo/delete/
    // users-combo + users/delete). The slug segment is the decoded
    // {badge_slug} — a junk encoding never claims (the null return).
    if (tail.length === 1 && tail[0] === "badges") return { family: "admin-badges" };
    if (tail.length === 2 && tail[0] === "badges" && tail[1] === "new") return { family: "admin-badge-new" };
    if (tail.length >= 3 && tail[0] === "badges" && tail[1] === "slug") {
      let badgeSlug: string;
      try {
        badgeSlug = decodeURIComponent(tail[2] as string);
      } catch {
        return null;
      }
      if (badgeSlug === "") return null;
      if (tail.length === 3) return { family: "admin-badge-view", badgeSlug };
      if (tail.length === 4 && tail[3] === "edit") return { family: "admin-badge-edit", badgeSlug };
      if (tail.length === 4 && tail[3] === "delete") return { family: "admin-badge-delete", badgeSlug };
      if (tail.length === 4 && tail[3] === "users") return { family: "admin-badge-users", badgeSlug };
      if (tail.length === 5 && tail[3] === "users" && tail[4] === "delete") return { family: "admin-badge-users-delete", badgeSlug };
    }
    // The R18 applications arm (web.go:865-872's /applications group): the
    // list GET, the create POST, the positive-integer delete POST. The
    // /oauth2/{id} edit combo + regenerate_secret stay unclaimed (unlanded
    // — the module's dead-link note; the engine's 404, upstream's own
    // unregistered-route answer for the same shapes minus these two).
    if (tail.length === 1 && tail[0] === "applications") return { family: "admin-applications" };
    if (tail.length === 2 && tail[0] === "applications" && tail[1] === "oauth2") return { family: "admin-application-create" };
    if (
      tail.length === 4 &&
      tail[0] === "applications" &&
      tail[1] === "oauth2" &&
      /^\d+$/.test(tail[2] as string) &&
      tail[3] === "delete"
    ) {
      return { family: "admin-application-delete", applicationId: Number.parseInt(tail[2] as string, 10) };
    }
    // The SPEC-0018 §3.2 config arm (web.go:788-794's /config group): the
    // read-only summary GET beside the notices arm. Upstream's ChangeConfig
    // POST, the settings editor page and the two test riders are the §3.2
    // §-outs (arming is a var edit + redeploy, never a runtime toggle), so
    // ONLY the bare literal claims — every other config/* tail stays
    // unclaimed → the engine's 404.
    if (tail.length === 1 && tail[0] === "config") return { family: "admin-config" };
    // The SPEC-0018 §3.1 notices arm (web.go:882-886's /notices group): the
    // paged GET and the two plain-form write POSTs (the module's mount
    // record). NO create route — notices are system-generated, upstream
    // and here.
    if (tail.length === 1 && tail[0] === "notices") return { family: "admin-notices" };
    if (tail.length === 2 && tail[0] === "notices" && tail[1] === "delete") return { family: "admin-notices-delete" };
    if (tail.length === 2 && tail[0] === "notices" && tail[1] === "empty") return { family: "admin-notices-empty" };
    // The census C6 arm (pages/repo-actions-queue.tsx — web.go:898-905's
    // /actions group's job_queue GET): the exact two-tail literal under the
    // admin scope.
    if (tail.length === 2 && tail[0] === "actions" && tail[1] === "job_queue") {
      return { family: "admin-actions-job-queue" };
    }
    // The admin actions RUNNERS family (pages/admin-actions-runners.tsx —
    // web.go:898-901's addSettingsRunnersRoutes inside the admin /actions
    // group + POST /runners/bulk): the static tails claim first (chi
    // static-before-dynamic), then the digits-only {id} combo (the house
    // PathParamInt64 idiom); deeper tails stay unclaimed → the engine's 404.
    if (tail.length === 3 && tail[0] === "actions" && tail[1] === "runners" && tail[2] === "bulk") {
      return { family: "admin-actions-runners-bulk" };
    }
    if (tail.length === 3 && tail[0] === "actions" && tail[1] === "runners" && tail[2] === "reset_registration_token") {
      return { family: "admin-actions-runners-token-reset" };
    }
    if (tail.length === 3 && tail[0] === "actions" && tail[1] === "runners" && /^\d+$/.test(tail[2] as string)) {
      return { family: "admin-actions-runners-edit", id: Number.parseInt(tail[2] as string, 10) };
    }
    if (
      tail.length === 4 &&
      tail[0] === "actions" &&
      tail[1] === "runners" &&
      /^\d+$/.test(tail[2] as string) &&
      tail[3] === "update-runner"
    ) {
      return { family: "admin-actions-runners-update", id: Number.parseInt(tail[2] as string, 10) };
    }
    if (
      tail.length === 4 &&
      tail[0] === "actions" &&
      tail[1] === "runners" &&
      /^\d+$/.test(tail[2] as string) &&
      tail[3] === "delete"
    ) {
      return { family: "admin-actions-runners-delete", id: Number.parseInt(tail[2] as string, 10) };
    }
    if (tail.length === 2 && tail[0] === "actions" && tail[1] === "runners") {
      return { family: "admin-actions-runners" };
    }
    // The admin actions VARIABLES family (pages/admin-actions-variables.tsx —
    // web.go:902's addSettingsVariablesRoutes): the /new static tail, the
    // digits-only {id} edit/delete combos, then the bare list literal.
    if (tail.length === 3 && tail[0] === "actions" && tail[1] === "variables" && tail[2] === "new") {
      return { family: "admin-actions-variables-new" };
    }
    if (
      tail.length === 4 &&
      tail[0] === "actions" &&
      tail[1] === "variables" &&
      /^\d+$/.test(tail[2] as string) &&
      tail[3] === "edit"
    ) {
      return { family: "admin-actions-variables-edit", id: Number.parseInt(tail[2] as string, 10) };
    }
    if (
      tail.length === 4 &&
      tail[0] === "actions" &&
      tail[1] === "variables" &&
      /^\d+$/.test(tail[2] as string) &&
      tail[3] === "delete"
    ) {
      return { family: "admin-actions-variables-delete", id: Number.parseInt(tail[2] as string, 10) };
    }
    if (tail.length === 2 && tail[0] === "actions" && tail[1] === "variables") {
      return { family: "admin-actions-variables" };
    }
    // The bare group literal (web.go:898's GET "" — misc.LocationRedirect's
    // 303 onto ./actions/runners, mounted INSIDE adminReq so the prologue
    // gates the redirect). The scoped-workflows tail (web.go:903) stays
    // unclaimed — no substrate (the module's documented reduction).
    if (tail.length === 1 && tail[0] === "actions") {
      return { family: "admin-actions-redirect" };
    }
    if (tail.length === 2 && tail[0] === "monitor") {
      if (tail[1] === "stats") return { family: "admin-monitor", page: "stats" };
      if (tail[1] === "cron") return { family: "admin-monitor", page: "cron" };
      if (tail[1] === "queue") return { family: "admin-monitor", page: "queue" };
      if (tail[1] === "stacktrace") return { family: "admin-monitor", page: "trace" };
    }
    return null;
  }

  // The wave-23 org members family (pages/org-members.tsx — upstream's
  // `/org/{org}/members` literal, web.go:957-961): the exact four-segment
  // shape with the literal `org` first segment and the literal `members`
  // third — the same exact-literal posture as org-create above (upstream's
  // /org group registers ahead of the dynamic pairs, so a repository path
  // /org/{repo}/members is shadowed identically; the "org" owner name is
  // create-time reserved besides). Every other /org/* shape (deeper tails,
  // /org/{org} alone) stays unclaimed → the engine's 404.
  if (raw.length === 4 && raw[1] === "org" && raw[3] === "members") {
    let orgName: string;
    try {
      orgName = decodeURIComponent(raw[2] as string);
    } catch {
      return null;
    }
    return { family: "org-members", owner: orgName };
  }
  // The ORG-scoped inbox families (pages/org-inbox.tsx — this wave's R07):
  // upstream web.go:986-991's exact 4-/5-segment shapes — the literal `org`
  // first segment (the /org group registers ahead of the dynamic pairs
  // upstream, the org-members precedent) + the `{org}` login + the three
  // overview literals + the optional `{team}` tail. Every other /org/*
  // shape stays unclaimed → the engine's 404.
  if (raw.length >= 4 && raw[1] === "org" && (raw[3] === "issues" || raw[3] === "pulls" || raw[3] === "milestones")) {
    if (raw.length > 5) return null;
    let orgName: string;
    try {
      orgName = decodeURIComponent(raw[2] as string);
    } catch {
      return null;
    }
    const kind = raw[3];
    if (raw.length === 4) return { family: "org-inbox", owner: orgName, kind };
    let team: string;
    try {
      team = decodeURIComponent(raw[4] as string);
    } catch {
      return null;
    }
    return { family: "org-inbox", owner: orgName, kind, team };
  }

  // The census R06 org dashboard family (pages/org-dashboard.tsx —
  // upstream's /org/{org}/dashboard[/{team}] literals, web.go:982-985): the
  // exact-literal posture beside org-members (the literal `org` first
  // segment + the literal `dashboard` third; a repository path
  // /org/{repo}/dashboard is shadowed identically upstream). The four-
  // segment shape is the all-teams arm; the five-segment adds the {team}
  // tail — ANY decodable segment, resolved case-folded against the org's
  // team lower names at load (org.go:213-218's EqualFold walk, the
  // RequireTeamMember arm at org.go:226-236 behind it; a miss 404-shells —
  // upstream answers its NotFound page for any team param, so the segment
  // claim is upstream-shaped). The heatmap tails (`/dashboard/-/heatmap[…]`,
  // R03) and every deeper shape stay unclaimed → the engine's 404.
  if (raw.length >= 4 && raw.length <= 5 && raw[1] === "org" && raw[3] === "dashboard") {
    let orgName: string;
    try {
      orgName = decodeURIComponent(raw[2] as string);
    } catch {
      return null;
    }
    if (raw.length === 4) return { family: "org-dashboard", owner: orgName };
    let teamName: string;
    try {
      teamName = decodeURIComponent(raw[4] as string);
    } catch {
      return null;
    }
    if (teamName === "") return null;
    return { family: "org-dashboard", owner: orgName, team: teamName };
  }

  let owner: string;
  try {
    owner = decodeURIComponent(raw[1] as string);
  } catch {
    return null;
  }
  // Reserved owner names can never exist in D1 (SPEC-0003 §3); refusing them
  // here keeps `/api/*` and the edge-served `/assets/*` tree engine-owned.
  if (isReservedOwnerName(owner)) return null;

  // The wave-6 single-segment family, wave-7-extended into the owner home
  // (pages/user-profile.tsx beside pages/org-home.tsx): `/{user-or-org}`.
  // The top-level literals stay with their routers (TOP_LEVEL_EXCLUDED), and
  // the `.keys`/`.gpg` suffixes are upstream's early-NotFound suffixes
  // (routers/web/user/home.go:728-735 for users, org/home.go:31-34 for orgs
  // — those upstream routes are not in this slice, so the names stay
  // refused and fall to the parent app's 404).
  if (raw.length === 2) {
    // Window-2e C1: the global inbox pages (pages/global-inbox.tsx —
    // upstream web.go:567-573, reqSignIn): claimed before the owner-home
    // arm could read them as single-segment profiles (upstream's literals
    // register ahead of the dynamic user route; a user named "issues" is
    // create-time reserved besides).
    if (raw[1] === "issues" || raw[1] === "pulls" || raw[1] === "milestones") {
      return { family: raw[1] === "issues" ? "global-issues" : raw[1] === "pulls" ? "global-pulls" : "global-milestones" };
    }
    if (TOP_LEVEL_EXCLUDED.has(owner.toLowerCase())) return null;
    // Window-2e: the feed suffixes (pages/user-feed-xml.ts — upstream
    // UsernameSubRoute's .rss/.atom dispatch, web.go:910-912 → profile.go).
    // The lowercase rule matches the landed .keys/.gpg refusal convention.
    const lowerOwner = owner.toLowerCase();
    if (lowerOwner.endsWith(".rss")) return { family: "user-feed-rss", owner: owner.slice(0, -4) };
    if (lowerOwner.endsWith(".atom")) return { family: "user-feed-atom", owner: owner.slice(0, -5) };
    if (lowerOwner.endsWith(".keys") || lowerOwner.endsWith(".gpg")) return null;
    return { family: "owner-home", owner };
  }

  let repo: string;
  try {
    repo = decodeURIComponent(raw[2] as string);
  } catch {
    return null;
  }
  if (repo.endsWith(".git")) repo = repo.slice(0, -4);
  if (repo === "") return null;

  // The wave-12 org teams families (pages/org-teams.tsx — upstream's
  // /{org}/teams group, web.go:993-1013): the literal `teams` second segment
  // claimed before the tail parse could read it as a repository named
  // "teams" (the notifications/explore precedent). Upstream shadows such a
  // repo identically — the org route group registers at web.go:993, ahead
  // of :1292's `/{username}/{reponame}` — so /{user}/teams 404-shells at
  // resolve time exactly like upstream's OrgAssignment miss. The bare URL
  // is the list; `new` the create form (the static literal upstream
  // registers ahead of the {team} param, chi tree order); a positive
  // integer the id-keyed detail slice (the landed /teams/{id} read arms —
  // PathParamInt64 parity, so "007" parses as 7); any OTHER decoded segment
  // the R19 NAME carrier — upstream's team page takes any {team} param and
  // resolves it case-folded against the lower names (web.go:997's param,
  // org.go:213-218's EqualFold walk), 404-shelling the miss, so the claim
  // mirrors upstream (the loader reproduces the miss as the shell). Wave 49
  // (pages/org-settings.tsx) adds the {id}/edit combo and the {id}/delete
  // write (web.go:1011-1013 — the same positive-integer claim, keyed on the
  // id carrier only: a name carrier has no landed edit/delete read arms,
  // so five-segment name tails stay unclaimed → the engine's 404). Every
  // other tail (`/{id}/repositories`, the `/action/*` writes) stays
  // unclaimed → the engine's 404.
  if (repo === "teams") {
    if (raw.length === 3) return { family: "org-teams", owner };
    if (raw.length === 4) {
      if (raw[3] === "new") return { family: "org-team-new", owner };
      if (/^\d+$/.test(raw[3] as string)) {
        return { family: "org-team-detail", owner, id: Number.parseInt(raw[3] as string, 10) };
      }
      // The R19 name carrier (the module header's route-shape note).
      try {
        return { family: "org-team-detail", owner, name: decodeURIComponent(raw[3] as string) };
      } catch {
        return null;
      }
    }
    if (raw.length === 5 && /^\d+$/.test(raw[3] as string)) {
      if (raw[4] === "edit") return { family: "org-team-edit", owner, id: Number.parseInt(raw[3] as string, 10) };
      if (raw[4] === "delete") return { family: "org-team-delete", owner, id: Number.parseInt(raw[3] as string, 10) };
    }
    return null;
  }

  // The wave-14 org labels families (pages/org-labels.tsx — the brief's
  // literal `/{org}/labels` + upstream's three POST segments): the literal
  // `labels` second segment claimed before the tail parse could read it as a
  // repository named "labels" (the teams precedent; upstream nests the page
  // under /org/{org}/settings/labels and shadows nothing here — pages/
  // org-labels.tsx's divergence note). The `/labels/initialize` template
  // loader and every other tail stay unclaimed → the engine's 404.
  if (repo === "labels") {
    if (raw.length === 3) return { family: "org-labels", owner };
    if (raw.length === 4) {
      if (raw[3] === "new") return { family: "org-label-new", owner };
      if (raw[3] === "edit") return { family: "org-label-edit", owner };
      if (raw[3] === "delete") return { family: "org-label-delete", owner };
    }
    return null;
  }

  // The wave-49 org settings families (pages/org-settings.tsx — upstream's
  // require-owner /{org} group's /settings subtree, web.go:1017-1092): the
  // literal `settings` second segment claimed before the tail parse could
  // read it as a repository named "settings" (the teams/labels precedent;
  // upstream's group registers ahead of :1292 and shadows such a repo
  // identically — a non-owner's miss 404-shells at resolve time, upstream's
  // RequireOwner OrgAssignment NotFound). The `user` first segment is
  // EXCLUDED: upstream's reqSignIn /user group registers ahead of the org
  // groups and owns the whole /user/* namespace (the wave-12 user-settings
  // literal's prefix — /user/settings/* stays the user family's shapes, not
  // an org named "user"). The bare URL is the options combo; the deeper
  // literals are exactly upstream's POST segments (the avatar pair, the
  // danger-zone rename/delete/visibility arms). Wave 53 (pages/
  // org-settings-hooks.tsx) adds the `/hooks` group's shapes — web.go:1033-1044:
  // the bare webhooks list + add-form combo and the {id} edit page (the
  // shared WebHooksEdit; integer-id claim, the repo hooks-family
  // PathParamInt64 parity so "007" parses as 7 and a negative 404-shells on
  // the lookup) + the {id}/delete write (the landed repo page's arm-scoped
  // convention — upstream's shared /delete?id= target is the list trash
  // buttons' form, which this UI does not render). The landed tabs' claims
  // grew with their waves (hooks, blocked_users, applications, audit_logs —
  // each literal's line carries its citation); every other tail (the
  // packages/actions-management tabs — separate pages not landed) stays
  // unclaimed → the engine's 404.
  if (repo === "settings" && owner.toLowerCase() !== "user") {
    if (raw.length === 3) return { family: "org-settings", owner };
    if (raw.length === 4) {
      if (raw[3] === "avatar") return { family: "org-settings-avatar", owner };
      if (raw[3] === "rename") return { family: "org-settings-rename", owner };
      if (raw[3] === "delete") return { family: "org-settings-delete", owner };
      if (raw[3] === "visibility") return { family: "org-settings-visibility", owner };
      if (raw[3] === "hooks") return { family: "org-settings-hooks", owner };
      // Window-2b: the blocked_users tab (the committed two-stage module);
      // the actions sub-tab tails are claimed below the length-4 block.
      if (raw[3] === "blocked_users") return { family: "org-settings-blocked", owner };
      // The R20-a applications tab (the committed module — the list; the
      // create/delete tails are claimed below the length-4 block).
      if (raw[3] === "applications") return { family: "org-settings-applications", owner };
      // The R20 +audit_logs arm / R13 org mount (pages/settings-audit-logs.tsx
      // — web.go:1069's literal `m.Get("/audit_logs", org_setting.ViewAudit
      // Logs)`, GET only; the shared renderer sits under the group's
      // RequireOwner gate). Query arms ride the URL, so any deeper tail stays
      // unclaimed → the engine's 404.
      if (raw[3] === "audit_logs") return { family: "org-settings-audit-logs", owner };
    }
    if (raw.length === 5 && raw[3] === "applications" && raw[4] === "oauth2") {
      return { family: "org-settings-applications-create", owner };
    }
    if (raw.length === 5 && raw[3] === "actions" && raw[4] === "secrets") {
      return { family: "org-actions-secrets", owner };
    }
    if (raw.length === 6 && raw[3] === "actions" && raw[4] === "secrets" && raw[5] === "delete") {
      return { family: "org-actions-secrets-delete", owner };
    }
    if (raw.length === 5 && raw[3] === "actions" && raw[4] === "variables") {
      return { family: "org-actions-variables", owner };
    }
    if (raw.length === 6 && raw[3] === "actions" && raw[4] === "variables" && raw[5] === "new") {
      return { family: "org-actions-variables-new", owner };
    }
    if (raw.length === 7 && raw[3] === "actions" && raw[4] === "variables" && raw[6] === "edit" && /^-?\d+$/.test(raw[5] as string)) {
      return { family: "org-actions-variables-edit", owner, id: Number.parseInt(raw[5] as string, 10) };
    }
    if (raw.length === 7 && raw[3] === "actions" && raw[4] === "variables" && raw[6] === "delete" && /^-?\d+$/.test(raw[5] as string)) {
      return { family: "org-actions-variables-delete", owner, id: Number.parseInt(raw[5] as string, 10) };
    }
    // The census C7 org arm (pages/org-settings-actions-runners.tsx —
    // upstream web.go:1058's addSettingsRunnersRoutes inside the org
    // /actions group): the list GET, the reset-token POST (the LITERAL
    // claims ahead of the {id} combo — chi's static-first dispatch,
    // web.go:507-512), the {id} edit combo (GET page + POST description)
    // and the two write POSTs. The runner ids claim integers only (the
    // repo runners family's PathParamInt64 parity: junk fails the parse, a
    // negative parses and 404-shells on the scope lookup). Every other
    // tail stays unclaimed → the engine's 404.
    if (raw.length === 5 && raw[3] === "actions" && raw[4] === "runners") {
      return { family: "org-actions-runners", owner };
    }
    if (raw.length === 6 && raw[3] === "actions" && raw[4] === "runners" && raw[5] === "reset_registration_token") {
      return { family: "org-actions-runners-token-reset", owner };
    }
    if (raw.length === 6 && raw[3] === "actions" && raw[4] === "runners" && /^-?\d+$/.test(raw[5] as string)) {
      return { family: "org-actions-runners-edit", owner, id: Number.parseInt(raw[5] as string, 10) };
    }
    if (raw.length === 7 && raw[3] === "actions" && raw[4] === "runners" && raw[6] === "update-runner" && /^-?\d+$/.test(raw[5] as string)) {
      return { family: "org-actions-runners-update", owner, id: Number.parseInt(raw[5] as string, 10) };
    }
    if (raw.length === 7 && raw[3] === "actions" && raw[4] === "runners" && raw[6] === "delete" && /^-?\d+$/.test(raw[5] as string)) {
      return { family: "org-actions-runners-delete", owner, id: Number.parseInt(raw[5] as string, 10) };
    }
    if (raw.length === 5 && raw[3] === "avatar" && raw[4] === "delete") {
      return { family: "org-settings-avatar-delete", owner };
    }
    if (raw.length === 5 && raw[3] === "hooks" && /^-?\d+$/.test(raw[4] as string)) {
      return { family: "org-settings-hook-detail", owner, id: Number.parseInt(raw[4] as string, 10) };
    }
    if (raw.length === 6 && raw[3] === "hooks" && /^-?\d+$/.test(raw[4] as string) && raw[5] === "delete") {
      return { family: "org-settings-hook-delete", owner, id: Number.parseInt(raw[4] as string, 10) };
    }
    // The R20-a delete tail (the landed arm-scoped convention — upstream's
    // shared list-template `data-url` target; the integer-id claim is the
    // hooks-family PathParamInt64 parity). The /oauth2/{id} SHOW/EDIT and
    // regenerate_secret shapes stay UNCLAIMED → the engine's 404 (no landed
    // edit page — the module header's reduction).
    if (raw.length === 7 && raw[3] === "applications" && raw[4] === "oauth2" && /^-?\d+$/.test(raw[5] as string) && raw[6] === "delete") {
      return { family: "org-settings-applications-delete", owner, id: Number.parseInt(raw[5] as string, 10) };
    }
    return null;
  }

  // The wave-23 org repositories family (pages/org-repos.tsx — upstream's
  // `/{username}/-/repositories`, web.go:1107's `/{username}/-` group's
  // web.go:1134 repositories route): the `-` pseudo-segment namespace claims
  // exactly the repositories tail (a repo cannot be named "-" and no landed
  // family reads the shape, so the claim shadows nothing). Wave 37 adds the
  // sibling bare projects tail (web.go:1143's read group — pages/
  // owner-projects.tsx) and wave 40 the projects board depth + write group
  // (web.go:1140-1155 — pages/owner-project-board.tsx, the board route
  // interface's shape contract). Every other `/-*` tail (`/-/heatmap`,
  // `/-/packages*`, `/-/code`, the bare `/-`) stays unclaimed → the engine's
  // 404, exactly upstream's unregistered-route answer for slices that have
  // not landed.
  if (repo === "-" && raw.length === 4 && raw[3] === "repositories") {
    return { family: "org-repositories", owner };
  }
  // The owner heatmap JSON tail (pages/owner-heatmap.ts — this wave):
  // upstream web.go:1135's `m.Get("/heatmap", user.DashboardHeatmap)` in
  // the `/{username}/-` group. The exact 4-segment shape claims beside the
  // repositories/projects literals (disjoint third segments — the `-`
  // pseudo-segment namespace shadows nothing, the ae32b1a rule; the census's
  // Open Issues #8 note).
  if (repo === "-" && raw.length === 4 && raw[3] === "heatmap") {
    return { family: "owner-heatmap", owner };
  }
  // The codesearch-M1 owner code-search tail (pages/user-code-search.tsx —
  // this wave): upstream web.go:1136's `m.Get("/code", user.CodeSearch)` in
  // the `/{username}/-` group. The exact 4-segment shape claims beside the
  // heatmap/repositories/projects literals (disjoint third segments — the
  // `-` pseudo-segment namespace shadows nothing, the ae32b1a rule).
  if (repo === "-" && raw.length === 4 && raw[3] === "code") {
    return { family: "user-code-search", owner };
  }
  // The SPEC-0016 M2 packages subtree (pages/packages.tsx — upstream's
  // web.go:1109-1121 packages routes in the `/{username}/-` group): the
  // list literal beside the repositories/heatmap/code/projects siblings,
  // then the depth — `/{type}/{name}` the RedirectToLastVersion 303, the
  // `/versions` static tail outranking the `{version}` param (chi
  // registers the literal first), `/{version}` the view, and the
  // `/files/{fileid}` download (the id claim is the PathParamInt64 parity —
  // "007" parses as 7; junk segments stay unclaimed → the engine's 404,
  // exactly upstream's unregistered-tail answer). The type/name/version
  // decodes ride the /src family's try/catch shape.
  if (repo === "-" && raw.length >= 4 && raw[3] === "packages") {
    if (raw.length === 4) return { family: "owner-packages", owner };
    // The bare {type} tail claims nothing — the type facet rides the list's
    // `?type=` query (the landed parseTypeFacet), so a 5-segment shape stays
    // unclaimed → the engine's 404.
    if (raw.length === 5) return null;
    let type: string;
    let name: string;
    try {
      type = decodeURIComponent(raw[4] as string);
      name = decodeURIComponent(raw[5] as string);
    } catch {
      return null;
    }
    if (raw.length === 6) return { family: "owner-package-redirect", owner, type, name };
    if (raw.length === 7) {
      if (raw[6] === "versions") return { family: "owner-package-versions", owner, type, name };
      let version: string;
      try {
        version = decodeURIComponent(raw[6] as string);
      } catch {
        return null;
      }
      return { family: "owner-package-version-view", owner, type, name, version };
    }
    if (raw.length === 9 && raw[7] === "files" && /^\d+$/.test(raw[8] as string)) {
      let version: string;
      try {
        version = decodeURIComponent(raw[6] as string);
      } catch {
        return null;
      }
      return {
        family: "owner-package-file-download",
        owner,
        type,
        name,
        version,
        fileId: Number.parseInt(raw[8] as string, 10),
      };
    }
    return null;
  }
  if (repo === "-" && raw.length >= 4 && raw[3] === "projects") {
    if (raw.length === 4) return { family: "owner-projects", owner };
    const tail = raw.slice(4);
    const head = tail[0] as string;
    // The write group's `/new` literal (registered ahead of the {id} param
    // upstream — chi static-before-dynamic).
    if (tail.length === 1 && head === "new") return { family: "owner-project-new", owner };
    // The {id} shapes claim positive integers only (the org-teams detail
    // precedent — "007" parses as 7; junk segments stay engine-owned where
    // upstream's PathParamInt64-zero arm would ServerError).
    if (/^\d+$/.test(head)) {
      const id = Number.parseInt(head, 10);
      if (tail.length === 1) return { family: "owner-project-board", owner, id };
      if (tail.length === 2) {
        if (tail[1] === "edit") return { family: "owner-project-edit", owner, id };
        if (tail[1] === "delete") return { family: "owner-project-delete", owner, id };
        if (tail[1] === "open") return { family: "owner-project-status", owner, id, action: "open" };
        if (tail[1] === "close") return { family: "owner-project-status", owner, id, action: "close" };
        if (tail[1] === "workflows") return { family: "owner-project-workflows", owner, id };
      }
      if (tail.length === 3) {
        if (tail[1] === "columns" && tail[2] === "new") {
          return { family: "owner-project-column-new", owner, id };
        }
        if (tail[1] === "workflows" && /^\d+$/.test(tail[2] as string)) {
          return {
            family: "owner-project-workflows",
            owner,
            id,
            workflowId: Number.parseInt(tail[2] as string, 10),
          };
        }
        if (/^\d+$/.test(tail[1] as string) && tail[2] === "default") {
          return {
            family: "owner-project-column-default",
            owner,
            id,
            columnId: Number.parseInt(tail[1] as string, 10),
          };
        }
      }
      if (
        tail.length === 4 &&
        tail[1] === "workflows" &&
        /^\d+$/.test(tail[2] as string) &&
        tail[3] === "delete"
      ) {
        return {
          family: "owner-project-workflow-delete",
          owner,
          id,
          workflowId: Number.parseInt(tail[2] as string, 10),
        };
      }
    }
    return null;
  }

  const tail = raw.slice(3);
  if (tail.length === 0) return { family: "home", owner, repo, refSuffix: null };

  // Family literals are lowercase-exact, like upstream's chi patterns
  // (`{type:branch|tag|commit}` routes; `gitea/routers/web/web.go:1749`).
  const [head, ...rest] = tail;
  // Wave-2 families: /tree re-emits its suffix RAW (RedirectRepoTreeToSrc
  // swaps the still-encoded text, view_home.go:521). /issues and /pulls
  // claim the bare list URLs plus the wave-3 single-integer detail tail
  // (upstream chi `/{index}` + PathParamInt64: "007" is 7, a negative is
  // admitted here and 404-shells on the row lookup) and — wave 4 — the
  // `/issues/new` form (the family literal wins before the integer shape
  // could, and the POST carries no family of its own). Anything else in the
  // space (`/issues/1/comments`, non-numeric) stays engine-owned, the same
  // posture as `/commit/{sha}` (§1.2, open question 1). `/settings` claims
  // the bare basics URL and the `/settings/hooks` sub-page (wave 4); the
  // deeper settings space stays engine-owned.
  if (head === "tree") return { family: "tree", owner, repo, rawSuffix: rest.join("/") };
  // Wave-39: the blob-redirect twin of the tree arm (upstream
  // RedirectRepoBlobToCommit, view_home.go:528-536 — the still-encoded
  // suffix re-emitted onto /src/commit/; the bare /blob claims the shape and
  // 404-shells at the dispatcher, the tree family's arm).
  if (head === "blob") return { family: "blob-redirect", owner, repo, rawSuffix: rest.join("/") };
  // Wave-39: the find-file aux family (upstream web.go:1297-1306's three
  // typed sub-routes over repo.TreeList). The type literal is the route
  // shape — chi registers exactly branch/tag/commit, so any other segment
  // and the bare/below-minimum tails (chi's `/*` needs the typed tail) stay
  // engine-owned; the decoded tail is the /src family's ref+path shape (the
  // handler resolves only the ref half — the module doc).
  if (head === "tree-list") {
    const typed = rest[0];
    if (rest.length < 2 || (typed !== "branch" && typed !== "tag" && typed !== "commit")) return null;
    try {
      return {
        family: "tree-list-aux",
        owner,
        repo,
        refType: typed,
        refSuffix: rest.slice(1).map((segment) => decodeURIComponent(segment)).join("/"),
      };
    } catch {
      return null;
    }
  }
  // Wave-43: the tree-view envelope family (upstream web.go:1302-1306's
  // three typed sub-routes over repo.TreeViewNodes — the tree-list twin's
  // shape). The type literal is the route shape — chi registers exactly
  // branch/tag/commit, so any other segment and the bare/below-minimum
  // tails stay engine-owned; the decoded tail is the /src family's ref+path
  // shape (both halves are load-bearing here — the walk roots at the path
  // half; `?sub_path=` rides the query, the handler reads it).
  if (head === "tree-view") {
    const typed = rest[0];
    if (rest.length < 2 || (typed !== "branch" && typed !== "tag" && typed !== "commit")) return null;
    try {
      return {
        family: "tree-view-aux",
        owner,
        repo,
        refType: typed,
        refSuffix: rest.slice(1).map((segment) => decodeURIComponent(segment)).join("/"),
      };
    } catch {
      return null;
    }
  }
  // Wave-46: the lastcommit fragment family (upstream web.go:1761's
  // `m.Get("/lastcommit/*", RepoRefByType(RefTypeCommit), repo.LastCommit)`).
  // The wildcard claims the bare URL too (chi's `*` matches the empty tail —
  // the archive family's precedent), which upstream answers with the DEFAULT
  // BRANCH's root listing; the landed commit-arm convention declines that
  // default-branch swap (the module doc's HEAD note), so the bare tail rides
  // the family and 404-shells at the handler (parseLastCommitTail's miss).
  // The tail decodes per segment (parseLastCommitTail's input contract); an
  // undecodable segment is not ours (the parse prefilter's posture).
  if (head === "lastcommit") {
    try {
      return { family: "lastcommit", owner, repo, rawTail: rest.map((segment) => decodeURIComponent(segment)).join("/") };
    } catch {
      return null;
    }
  }
  // Wave-46: the blob-excerpt fragment families (upstream web.go:1735's
  // repo twin + web.go:1618's wiki twin over repo.ExcerptBlob). The `{sha}`
  // param is a plain chi single segment (no hex shape — the handler's
  // GetCommit miss is the 404 family), so the claims are the exact
  // 3-segment (repo) and 5-segment (wiki) shapes; deeper or shorter tails
  // stay unclaimed → the engine's 404, exactly upstream's unregistered-route
  // answer.
  if (head === "blob_excerpt") {
    if (rest.length !== 1) return null;
    try {
      return { family: "blob-excerpt", owner, repo, sha: decodeURIComponent(rest[0] as string) };
    } catch {
      return null;
    }
  }
  if (head === "wiki") {
    // The wiki-blob-excerpt twin claims ONLY its exact 5-segment shape
    // (web.go:1618); every OTHER wiki tail falls through to the wiki
    // family arm below (window-2e C2a). The early `return null` for
    // non-excerpt shapes shadowed that arm entirely — the mounted wiki
    // family was unreachable dead code (the wiki matrix's RED; the
    // mount's dispatcher run never exercised these routes).
    if (rest.length === 2 && rest[0] === "blob_excerpt") {
      try {
        return { family: "wiki-blob-excerpt", owner, repo, sha: decodeURIComponent(rest[1] as string) };
      } catch {
        return null;
      }
    }
    // The raw byte arm (pages/wiki-raw.ts — web.go:1621's
    // `m.Get("/raw/*", repo.WikiRaw)`): EXACTLY the `raw/{tail}` shape;
    // the bare `/wiki/raw` tail falls through to the wiki page family
    // below (chi's `/raw/*` wildcard does not match `/raw`, which serves
    // the reserved-name page miss there). Per-segment decode + "/" join
    // (the wiki family's rawTail convention); a bad escape is the
    // engine's 404. MUST claim HERE — the `family: "wiki"` catch-all
    // below would otherwise swallow every raw tail.
    if (rest.length >= 2 && rest[0] === "raw") {
      try {
        return {
          family: "wiki-raw",
          owner,
          repo,
          rawTail: rest.slice(1).map((segment) => decodeURIComponent(segment)).join("/"),
        };
      } catch {
        return null;
      }
    }
  }
  // The comments/attachments fragment (web.go:1337 — the repo-level
  // comments head, GET-only; the issue-level comment writes live under
  // {type}/{index} — a different namespace).
  if (head === "comments" && rest.length === 2 && rest[1] === "attachments") {
    return { family: "comment-attachments", owner, repo, segment: rest[0] };
  }
  // Window-2e B2: the activity-author JSON feed (web.go:1683-1687 — the
  // optional period tail; unknown/bare segments hit the WEEKLY default).
  if (head === "activity_author_data") {
    if (rest.length === 0) return { family: "activity-author-data", owner, repo };
    if (rest.length === 1) return { family: "activity-author-data", owner, repo, segment: rest[0] };
  }
  // The census R14 repo activity page (web.go:1628-1631 — the /activity
  // group's two page GETs over `repo.Activity`). The period tail is the RAW
  // segment (the activity-author-data convention): activity.go:30-45's
  // switch has no 4xx arm, unknown segments render the WEEKLY window with
  // the weekly item active, and the bare URL parses as period null. The
  // three chart literals claim to the R15 chart family (pages/repo-charts.tsx)
  // BEFORE the period arm — upstream chi dispatches the chart group's static
  // routes ahead of the /{period} param (web.go:1633-1646, the R15 census
  // row, LANDED); deeper junk tails stay unclaimed → the engine's 404.
  if (head === "activity") {
    if (rest.length === 0) return { family: "repo-activity", owner, repo, period: null };
    // The R15 chart literals are NOT period values — upstream chi dispatches
    // /activity/contributors etc. to the chart group's static routes ahead of
    // the /{period} param (web.go:1633-1646). Page GETs claim kind + tail
    // null; the /data JSON tails claim tail "data" (chi registers exactly
    // "" and "/data" per group — anything else falls through to the 404).
    if (rest[0] === "contributors" || rest[0] === "code-frequency" || rest[0] === "recent-commits") {
      const kind: RepoChartKind = rest[0];
      if (rest.length === 1) return { family: "repo-charts", owner, repo, kind, tail: null };
      if (rest.length === 2 && rest[1] === "data") return { family: "repo-charts", owner, repo, kind, tail: "data" };
    } else if (rest.length === 1) {
      return { family: "repo-activity", owner, repo, period: rest[0] ?? null };
    }
  }

  // The census C1 runs-list family (pages/repo-actions-runs.tsx — upstream
  // web.go:1606-1608's `m.Get("", actions.List)` opening the /actions
  // group). The BARE literal claims; every sibling tail (`/job_queue` C6's,
  // `/runs/{run}` C2's, `/run`, `/disable`, `/enable`,
  // `/workflow-dispatch-inputs`, `/approve-all-checks`, the badge route)
  // stays unclaimed → the engine's 404 until its unit lands (the
  // RepoActionsRunsRoute interface's claim note). The `?run_ids=` fragment
  // discriminator rides the query, not the path.
  if (head === "actions" && rest.length === 0) {
    return { family: "repo-actions-runs", owner, repo };
  }

  // The census C6 job-queue family (pages/repo-actions-queue.tsx — upstream
  // web.go:1570's `m.Get("/job_queue", actions.JobQueue)` inside the /actions
  // group, beside the C1 runs-list claim above). The exact literal only:
  // `/actions/job_queue/anything` and every other sibling tail (`/runs/{run}`
  // C2's, `/run`, `/disable`, `/enable`, `/workflow-dispatch-inputs`,
  // `/approve-all-checks`, the badge route) stay unclaimed → the engine's
  // 404 until their units land. The `?refresh=1` fragment discriminator
  // rides the query, not the path.
  if (head === "actions" && rest.length === 1 && rest[0] === "job_queue") {
    return { family: "repo-actions-job-queue", owner, repo };
  }

  // The census C2 run-viewer subtree (pages/repo-actions-view.tsx —
  // web.go:1601-1605's cancel POST + the three GET+POST view pairs under
  // /runs). The {run}/{attempt}/{job} segments claim for ANY single-segment
  // value (chi params — junk parses to PathParamInt64's 0, the loader's
  // 404/absent arms), the exact literal tails only; every deeper tail
  // (`/runs/{run}/attempts/{n}/...`) and the remaining siblings (`/run`,
  // `/disable`, `/enable`, `/workflow-dispatch-inputs`,
  // `/approve-all-checks`, `/runs/{run}/rerun*`, `/runs/{run}/workflow`,
  // `/runs/{run}/logs`, the artifacts tails) stay unclaimed → the engine's
  // 404 until their units land (the RepoActionsRunViewRoute interface's
  // note).
  if (head === "actions" && rest.length >= 3 && rest[0] === "runs") {
    if (rest.length === 3 && rest[2] === "cancel") {
      return { family: "actions-run-cancel", owner, repo, run: rest[1] as string };
    }
    // The F-row tail: the run→workflow-file redirect (web.go:1591 — the
    // exact 3-segment literal, disjoint from cancel's).
    if (rest.length === 3 && rest[2] === "workflow") {
      return { family: "actions-run-workflow", owner, repo, run: rest[1] as string };
    }
    if (rest.length === 4 && rest[2] === "attempts") {
      return { family: "actions-run-view", owner, repo, run: rest[1] as string, attempt: rest[3] as string };
    }
    if (rest.length === 4 && rest[2] === "jobs") {
      return { family: "actions-run-view", owner, repo, run: rest[1] as string, job: rest[3] as string };
    }
    // The census C4 remainder (pages/repo-actions-artifacts-download.ts —
    // web.go:1595-1596's /artifacts/{artifact_name} GET+DELETE): the name is
    // ONE decoded segment; a malformed escape stays unclaimed (upstream chi
    // 404s it too).
    if (rest.length === 4 && rest[2] === "artifacts") {
      let artifactName: string;
      try {
        artifactName = decodeURIComponent(rest[3] as string);
      } catch {
        return null;
      }
      return { family: "actions-run-artifact", owner, repo, run: rest[1] as string, artifactName };
    }
    // The F-row tail: the JOB-SCOPED log download (web.go:1589 — the exact
    // 5-segment shape; upstream has NO run-level logs route).
    if (rest.length === 5 && rest[4] === "logs") {
      return { family: "actions-run-job-logs", owner, repo, run: rest[1] as string, job: rest[3] as string };
    }
    return null;
  }
  if (head === "actions" && rest.length === 2 && rest[0] === "runs") {
    return { family: "actions-run-view", owner, repo, run: rest[1] as string };
  }

  // The F-row tail: the workflow BADGE (web.go:1606 — the exact 3-segment
  // /workflows/{name}/badge.svg shape; the name rides raw, chi's own param).
  if (head === "actions" && rest.length === 3 && rest[0] === "workflows" && rest[2] === "badge.svg") {
    return { family: "repo-actions-workflow-badge", owner, repo, workflowName: rest[1] as string };
  }
  // The F-row tail: the dispatch-modal inputs FRAGMENT (web.go:1572 — the
  // exact literal; the ref/workflow facets ride the query).
  if (head === "actions" && rest.length === 1 && rest[0] === "workflow-dispatch-inputs") {
    return { family: "repo-actions-dispatch-inputs", owner, repo };
  }
  // The census C4 artifacts preview subtree (pages/repo-actions-artifacts.tsx
  // — web.go:1602-1603's /artifacts/{artifact_id}/preview[/...] inside the
  // /actions group): the {id} claims digits only (the house PathParamInt64
  // idiom — "007" parses as 7; junk stays engine-owned, upstream's
  // unregistered-tail answer); the tail beyond /preview/ decodes per segment
  // and rejoins with "/" separators (pathEscapeSegments keeps them). The
  // siblings (`/runs/{run}/artifacts/{name}` download/delete, the bare
  // `/artifacts/{id}`) stay unclaimed → the engine's 404.
  if (
    head === "actions" &&
    rest.length >= 3 &&
    rest[0] === "artifacts" &&
    rest[2] === "preview" &&
    /^\d+$/.test(rest[1] as string)
  ) {
    const artifactId = Number.parseInt(rest[1] as string, 10);
    if (rest.length === 3) {
      return { family: "actions-artifact-preview", owner, repo, artifactId, previewPath: "" };
    }
    const tail: string[] = [];
    for (const segment of rest.slice(3)) {
      try {
        tail.push(decodeURIComponent(segment));
      } catch {
        return null;
      }
    }
    return { family: "actions-artifact-preview", owner, repo, artifactId, previewPath: tail.join("/") };
  }

  if (head === "issues" || head === "pulls") {
    // Window-2e folds: the pulls/new redirect (web.go:1314) — MUST claim or
    // the dispatcher's handlesUiRoute consult hands it to the engine before
    // Hono ever routes it (the issue-new matrix's second RED; the third
    // dead-route-class catch this session).
    if (head === "pulls" && rest[0] === "new") {
      return { family: "pulls-new-redirect", owner, repo };
    }
    if (rest.length === 0) return { family: head, owner, repo };
    // The template chooser (web.go:1357 — the no-template 303 arm IS the
    // page at our data gate): the length-2 tail claims OUTSIDE the length-1
    // block below (the bare /issues/new literal lives inside it).
    if (head === "issues" && rest.length === 2 && rest[0] === "new" && rest[1] === "choose") {
      return { family: "issue-new-choose", owner, repo };
    }
    if (rest.length === 1) {
      if (head === "issues" && rest[0] === "new") return { family: "issue-new", owner, repo };
      // Wave-5: the sidebar label-write POST (upstream data-update-url).
      if (head === "issues" && rest[0] === "labels") return { family: "issue-labels", owner, repo };
      // Wave-11: the review-request + dismiss POSTs (web.go:1435-1436 —
      // repo-scoped, the issue/review ids ride the form fields).
      if (head === "issues" && rest[0] === "request_review") return { family: "issue-request-review", owner, repo };
      if (head === "issues" && rest[0] === "dismiss_review") return { family: "issue-dismiss-review", owner, repo };
      // Window-2e B2: the aux feeds (upstream web.go:1341/1359 — the
      // suggestions route sits in the labels/milestones sibling group).
      if (head === "issues" && rest[0] === "search") return { family: "issues-search-aux", owner, repo };
      if (head === "issues" && rest[0] === "suggestions") return { family: "issues-suggestions-aux", owner, repo };
      if (/^-?\d+$/.test(rest[0] as string)) {
        return { family: "issue-detail", owner, repo, urlKind: head, index: Number.parseInt(rest[0] as string, 10) };
      }
    }
    // Wave-5: the comment write + the PR files view, under BOTH families'
    // index tails (upstream hangs /comments on `/{type:issues|pulls}/{index}`
    // — web.go:1376 — and /files on the pulls group only — web.go:1670).
    if (rest.length === 2 && /^-?\d+$/.test(rest[0] as string)) {
      const index = Number.parseInt(rest[0] as string, 10);
      if (rest[1] === "comments") return { family: "issue-comment", owner, repo, urlKind: head, index };
      if (head === "pulls" && rest[1] === "files") return { family: "pull-files", owner, repo, index };
      if (head === "pulls" && rest[1] === "commits") return { family: "pull-commits", owner, repo, index };
      // Window-2e B2: the info/attachments fragments (web.go:1321-1334,
      // both families) + the merge box (web.go:1659, pulls).
      if (rest[1] === "info") return { family: "issue-info", owner, repo, urlKind: head, index };
      if (rest[1] === "attachments") return { family: "issue-attachments", owner, repo, urlKind: head, index };
      if (head === "pulls" && rest[1] === "merge_box") return { family: "pull-merge-box", owner, repo, index };
    }
    if (rest.length === 3 && /^-?\d+$/.test(rest[0] as string)) {
      const index = Number.parseInt(rest[0] as string, 10);
      // The content-history fragments (issue_content_history.go's arms over
      // the landed snapshot store, cced424): the overview JSON, then the
      // list/detail dropdown arms. The query params (comment_id/history_id)
      // stay OUT of the route — the loader's FormInt64 reads them.
      if (rest[1] === "content-history" && rest[2] === "overview") {
        return { family: "issue-content-overview", owner, repo, urlKind: head, index };
      }
      if (rest[1] === "content-history" && rest[2] === "list") {
        return { family: "issue-content-history-list", owner, repo, urlKind: head, index };
      }
      if (rest[1] === "content-history" && rest[2] === "detail") {
        return { family: "issue-content-history-detail", owner, repo, urlKind: head, index };
      }
      // The soft-delete write (issue_content_history.go:183-236's
      // SoftDeleteContentHistory, web.go:1391 — the reqSignIn'd UPDATE
      // group): the detail arm's exact three-segment tail shape, POST-only.
      if (rest[1] === "content-history" && rest[2] === "soft-delete") {
        return { family: "issue-content-history-soft-delete", owner, repo, urlKind: head, index };
      }
      // The byte-serving alias: upstream mounts the uuid arm at
      // /{index}/attachments/{uuid} (web.go:1337) driving the same seam as
      // the site-level /attachments/{uuid} — a 302 onto it (the module's
      // handoff).
      if (rest[1] === "attachments" && rest[2] !== undefined && rest[2] !== "") {
        return { family: "issue-attachments-alias", owner, repo, urlKind: head, index, segment: rest[2] };
      }
      // The committed-range files page (web.go:1672) and the single-commit
      // page AT UPSTREAM'S PATH /pulls/{index}/commits/{sha} (web.go:1663 —
      // the /files/{sha} tail is upstream's pattern miss; the b48757e
      // divergence honored).
      if (head === "pulls" && rest[1] === "files" && parsePullFilesRange(rest[2] as string) !== null) {
        return { family: "pull-files-range", owner, repo, index, segment: rest[2] };
      }
      if (head === "pulls" && rest[1] === "commits" && parsePullFilesSingleCommit(rest[2] as string) !== null) {
        return { family: "pull-commit-files", owner, repo, index, segment: rest[2] };
      }
    }
    // Wave-11: the review verdict form POST (web.go:1678 — the
    // /pulls/{index}/files/reviews group's /submit tail; the GET new_comment
    // + POST comments code-comment siblings stay unclaimed, no landed UI).
    if (
      head === "pulls" &&
      rest.length === 4 &&
      /^-?\d+$/.test(rest[0] as string) &&
      rest[1] === "files" &&
      rest[2] === "reviews" &&
      rest[3] === "submit"
    ) {
      return { family: "pull-review-submit", owner, repo, index: Number.parseInt(rest[0] as string, 10) };
    }
    // Wave-29 (the survey's row 4): the raw-text download tails
    // `/{index}.{diff|patch}` — upstream web.go:1657-1658's pair under the
    // pulls group. Positive integers exactly (the landed API seam's
    // `^(\d+)\.(diff|patch)$` convention; a negative or junk index 404s in
    // upstream too — chi's PathParamInt64 miss — and stays engine-owned
    // here, the unregistered-route answer).
    if (head === "pulls" && rest.length === 1) {
      const dotted = /^(\d+)\.(diff|patch)$/.exec(rest[0] as string);
      if (dotted !== null) {
        return {
          family: "pull-diffpatch",
          owner,
          repo,
          index: Number.parseInt(dotted[1] as string, 10),
          ext: dotted[2] as "diff" | "patch",
        };
      }
    }
    return null;
  }
  if (head === "settings") {
    if (rest.length === 0) return { family: "settings", owner, repo };
    if (rest.length === 1 && rest[0] === "hooks") return { family: "settings-hooks", owner, repo };
    // Window-2d: the four settings-tab modules. The githooks group claims
    // BEFORE the numeric hooks/{id} block could matter ("git" fails the
    // numeric guard — explicit claims keep both owners unambiguous).
    if (rest.length === 2 && rest[0] === "hooks" && rest[1] === "git") {
      return { family: "settings-githooks", owner, repo };
    }
    if (rest.length === 3 && rest[0] === "hooks" && rest[1] === "git" && rest[2] !== undefined && rest[2] !== "") {
      return { family: "settings-githook", owner, repo, name: decodeURIComponent(rest[2]) };
    }
    if (rest.length === 1 && rest[0] === "tags") return { family: "settings-tags", owner, repo };
    if (rest.length === 2 && rest[0] === "tags" && rest[1] === "delete") {
      return { family: "settings-tags-delete", owner, repo };
    }
    if (rest.length === 2 && rest[0] === "tags" && /^-?\d+$/.test(rest[1] as string)) {
      return { family: "settings-tag-detail", owner, repo, id: Number.parseInt(rest[1] as string, 10) };
    }
    if (rest.length === 1 && rest[0] === "keys") return { family: "settings-keys", owner, repo };
    if (rest.length === 2 && rest[0] === "keys" && rest[1] === "delete") {
      return { family: "settings-keys-delete", owner, repo };
    }
    // The census R11 arm (pages/repo-settings-lfs.tsx — upstream
    // web.go:1249-1261's `m.Group("/settings/lfs", ...)` under the shared
    // reqRepoAdmin settings group): the four read surfaces — the list, the
    // {oid} detail, the pointer scan and the find form. The write tails
    // (delete / auto-associate / the locks trio) stay unclaimed — the pages
    // render no controls for them — so the engine answers those with its
    // 404, upstream's unregistered-route answer; the bare `/lfs/show`
    // literal and every deeper/junk tail likewise.
    if (rest.length === 1 && rest[0] === "lfs") return { family: "settings-lfs", owner, repo };
    if (rest.length === 2 && rest[0] === "lfs" && rest[1] === "pointers") {
      return { family: "settings-lfs-pointers", owner, repo };
    }
    if (rest.length === 2 && rest[0] === "lfs" && rest[1] === "find") {
      return { family: "settings-lfs-find", owner, repo };
    }
    if (rest.length === 3 && rest[0] === "lfs" && rest[1] === "show" && rest[2] !== undefined && rest[2] !== "") {
      try {
        return { family: "settings-lfs-show", owner, repo, name: decodeURIComponent(rest[2]) };
      } catch {
        return null;
      }
    }
    // The census R13 arm (pages/settings-audit-logs.tsx — web.go:1279's
    // literal `m.Get("/audit_logs", repo_setting.ViewAuditLogs)`, GET only;
    // the shared renderer sits under reqRepoAdmin like the whole settings
    // group). Query arms ride the URL (sort/action/origin/actor/page), so
    // any deeper tail stays unclaimed → the engine's 404, upstream's
    // unregistered-route answer.
    if (rest.length === 1 && rest[0] === "audit_logs") return { family: "settings-audit-logs", owner, repo };
    // The census C8 arm (pages/repo-settings-actions-secrets-variables.tsx —
    // upstream web.go:1266-1278's `m.Group("/actions", ...)` with the shared
    // secrets/variables builders web.go:498-506/489-496, behind
    // actions.MustEnableActions inside the reqRepoAdmin settings group): the
    // two sub-tabs' CRUD arms. The bare `/actions` LocationRedirect
    // (web.go:1267 — onto ./actions/general) and the runners/general/
    // scoped-workflows tails stay unclaimed — the engine's 404, upstream's
    // unregistered-route answer for the unlanded general tab (the org twin's
    // posture). The variable path ids claim integers only (the
    // settings-tag-detail PathParamInt64 parity: junk fails the parse, a
    // negative parses and 404-shells on the scope lookup).
    if (rest.length === 2 && rest[0] === "actions" && rest[1] === "secrets") {
      return { family: "settings-actions-secrets", owner, repo };
    }
    if (rest.length === 3 && rest[0] === "actions" && rest[1] === "secrets" && rest[2] === "delete") {
      return { family: "settings-actions-secrets-delete", owner, repo };
    }
    if (rest.length === 2 && rest[0] === "actions" && rest[1] === "variables") {
      return { family: "settings-actions-variables", owner, repo };
    }
    if (rest.length === 3 && rest[0] === "actions" && rest[1] === "variables" && rest[2] === "new") {
      return { family: "settings-actions-variables-new", owner, repo };
    }
    if (rest.length === 4 && rest[0] === "actions" && rest[1] === "variables" && rest[3] === "edit" && /^-?\d+$/.test(rest[2] as string)) {
      return { family: "settings-actions-variables-edit", owner, repo, id: Number.parseInt(rest[2] as string, 10) };
    }
    if (rest.length === 4 && rest[0] === "actions" && rest[1] === "variables" && rest[3] === "delete" && /^-?\d+$/.test(rest[2] as string)) {
      return { family: "settings-actions-variables-delete", owner, repo, id: Number.parseInt(rest[2] as string, 10) };
    }
    // The census C7 arm (pages/repo-settings-actions-runners.tsx — upstream
    // web.go:506-513's addSettingsRunnersRoutes inside the /actions group):
    // the list GET, the reset-token POST (the LITERAL claims ahead of the
    // {id} combo — chi's static-first dispatch, web.go:507-512), the
    // {id} edit combo (GET page + POST description) and the two write POSTs.
    // The runner ids claim integers only (the settings-actions-variables
    // PathParamInt64 parity: junk fails the parse, a negative parses and
    // 404-shells on the scope lookup). Every other tail (bare /runners/{id}/
    // junk, deeper) stays engine-owned.
    if (rest.length === 2 && rest[0] === "actions" && rest[1] === "runners") {
      return { family: "settings-actions-runners", owner, repo };
    }
    if (rest.length === 3 && rest[0] === "actions" && rest[1] === "runners" && rest[2] === "reset_registration_token") {
      return { family: "settings-actions-runners-token-reset", owner, repo };
    }
    if (rest.length === 3 && rest[0] === "actions" && rest[1] === "runners" && /^-?\d+$/.test(rest[2] as string)) {
      return { family: "settings-actions-runners-edit", owner, repo, id: Number.parseInt(rest[2] as string, 10) };
    }
    if (rest.length === 4 && rest[0] === "actions" && rest[1] === "runners" && rest[3] === "update-runner" && /^-?\d+$/.test(rest[2] as string)) {
      return { family: "settings-actions-runners-update", owner, repo, id: Number.parseInt(rest[2] as string, 10) };
    }
    if (rest.length === 4 && rest[0] === "actions" && rest[1] === "runners" && rest[3] === "delete" && /^-?\d+$/.test(rest[2] as string)) {
      return { family: "settings-actions-runners-delete", owner, repo, id: Number.parseInt(rest[2] as string, 10) };
    }
    // The census C9 arm (pages/repo-settings-actions-general.tsx — upstream
    // web.go:1262-1278's general group, mounted OUTSIDE MustEnableActions):
    // the bare literal (the redirect — its unit arm rides the HANDLER, not
    // the parse), the general page, and the actions_unit POST. The exact
    // literals only; the unlanded token-permissions/collaborative-owners
    // tails stay engine-owned (the module's documented-unrendered reduction).
    if (rest.length === 1 && rest[0] === "actions") {
      return { family: "settings-actions", owner, repo };
    }
    if (rest.length === 2 && rest[0] === "actions" && rest[1] === "general") {
      return { family: "settings-actions-general", owner, repo };
    }
    if (rest.length === 3 && rest[0] === "actions" && rest[1] === "general" && rest[2] === "actions_unit") {
      return { family: "settings-actions-general-unit", owner, repo };
    }
    if (rest.length === 1 && rest[0] === "public_access") {
      return { family: "settings-public-access", owner, repo };
    }
    // Window-2d pass 2: the wiki-config arm (options.tmpl's pieces).
    if (rest.length === 1 && rest[0] === "wiki") return { family: "settings-wiki", owner, repo };
    // Wave 10: the mirror panel (the brief's literal URL; upstream renders
    // the section on options.tmpl — pages/settings.tsx's divergence note).
    if (rest.length === 1 && rest[0] === "mirror") return { family: "settings-mirror", owner, repo };
    // Wave 14: the per-hook page + its two POST tails (upstream's
    // /settings/hooks/{id} WebHooksEdit + /{id}/test TestWebhook; the delete
    // rides the arm-scoped tail — upstream's shared /delete?id= form target
    // exists for the list trash buttons this UI does not render;
    // pages/settings.tsx's wave-14 header). PathParamInt64 parity: "007"
    // parses as 7, a negative is admitted here and 404-shells on the lookup
    // (the issue-detail convention). Any other tail (/settings/hooks/abc,
    // /{id}/edit, deeper) stays engine-owned — upstream has no such routes.
    if (rest.length >= 2 && rest[0] === "hooks" && /^-?\d+$/.test(rest[1] as string)) {
      const id = Number.parseInt(rest[1] as string, 10);
      if (rest.length === 2) return { family: "settings-hook-detail", owner, repo, id };
      if (rest.length === 3 && rest[2] === "test") return { family: "settings-hook-test", owner, repo, id };
      if (rest.length === 3 && rest[2] === "delete") return { family: "settings-hook-delete", owner, repo, id };
    }
    // Wave 15: the protected-branches family (pages/branch-protection.tsx —
    // upstream's literal group, web.go:1206-1212): the list, the shared
    // create/edit form at the `/edit` literal (the GET keyed by
    // `?rule_name=`, the POST by the hidden rule_id), the priority reorder
    // POST (upstream's JS sends the {ids} JSON; our no-JS form posts the
    // urlencoded repeated ids — pages/branch-protection.tsx's header), and
    // the id-keyed delete POST (PathParamInt64 parity, the hook-id
    // convention). Every deeper/junk tail (/branches/abc, /{id}/edit,
    // /edit/more) stays engine-owned.
    if (rest.length === 1 && rest[0] === "branches") return { family: "settings-branches", owner, repo };
    if (rest.length === 2 && rest[0] === "branches" && rest[1] === "edit") return { family: "settings-branch-edit", owner, repo };
    if (rest.length === 2 && rest[0] === "branches" && rest[1] === "priority") return { family: "settings-branch-priority", owner, repo };
    if (rest.length === 3 && rest[0] === "branches" && /^-?\d+$/.test(rest[1] as string) && rest[2] === "delete") {
      return { family: "settings-branch-delete", owner, repo, id: Number.parseInt(rest[1] as string, 10) };
    }
    // Wave 24: the collaboration panel + its four POST-only write tails
    // (pages/settings-collaboration.tsx — upstream web.go:1194-1204's
    // group): the `m.Combo("")` page (GET + POST the add-collaborator
    // write) and upstream's exact literal tails — /access_mode, /delete,
    // /team and /team/delete (the ids ride the form fields, upstream's
    // FormInt64 carriers, so no id appears in any pattern). Every other
    // /collaboration/* tail stays engine-owned.
    if (rest.length === 1 && rest[0] === "collaboration") return { family: "settings-collaboration", owner, repo };
    if (rest.length === 2 && rest[0] === "collaboration") {
      if (rest[1] === "access_mode") return { family: "settings-collab-access-mode", owner, repo };
      if (rest[1] === "delete") return { family: "settings-collab-delete", owner, repo };
      if (rest[1] === "team") return { family: "settings-collab-team-add", owner, repo };
    }
    if (rest.length === 3 && rest[0] === "collaboration" && rest[1] === "team" && rest[2] === "delete") {
      return { family: "settings-collab-team-delete", owner, repo };
    }
    return null;
  }
  // Wave-6: the milestones list (the bare URL, `?state=` carries the facet)
  // and the `/milestones/new` form (GET + POST). Wave 26 adds the `{id}/edit`
  // combo (upstream web.go:1427-1428 — the id segment decodes verbatim, the
  // loader validates it). The remaining write tails (`/{id}/{action}` close/
  // open, `/delete`) stay engine-owned — this slice renders no controls for
  // them (the dead-link rule), exactly upstream's unregistered-route answer
  // for shapes its router does claim but the slice does not.
  if (head === "milestones") {
    if (rest.length === 0) return { family: "milestones", owner, repo };
    if (rest.length === 1 && rest[0] === "new") return { family: "milestone-new", owner, repo };
    if (rest.length === 2 && rest[1] === "edit") {
      let id: string;
      try {
        id = decodeURIComponent(rest[0] as string);
      } catch {
        return null;
      }
      return { family: "milestone-edit", owner, repo, id };
    }
    return null;
  }
  // Wave-26 milestone detail (pages/milestone-detail.tsx — upstream
  // web.go:1340's SINGULAR `/milestone/{id}` route, the survey's TOP-3 row):
  // the exact single-segment tail claimed for ANY segment value so a
  // non-numeric id 404-shells through the loader (the commit-view sha
  // convention) instead of reaching the engine. Deeper tails stay
  // engine-owned; the bare `/milestone` falls through to the engine's 404 —
  // upstream has no such route.
  if (head === "milestone") {
    if (rest.length !== 1) return null;
    let id: string;
    try {
      id = decodeURIComponent(rest[0] as string);
    } catch {
      return null;
    }
    return { family: "milestone-detail", owner, repo, id };
  }
  // Wave-13: the compare family (pages/compare.tsx — upstream web.go:1307-
  // 1315). The bare URL and the full ParseCompareRouterParam tail grammar:
  // the FIRST `...` splits the decoded suffix (strings.Cut parity), else the
  // first `..` (the two-dot DirectComparison arm — the feeds module's
  // parseCompareBaseHead semantics, landed here for the page), else the
  // whole tail is the HEAD (upstream's single-ref family); an empty side is
  // the default-branch fallback (the loader's util.IfZero arm) and the head
  // part carries the fork forms (`{owner}:{ref}` / `{owner}/{repo}:{ref}` —
  // parseHead; the fork-edge resolution landed with the API's fork-PR flow).
  if (head === "wiki") {
    // Window-2e C2: the WIKI family (pages/repo-wiki.tsx — upstream
    // web.go:1611-1617's two combos; the SUB-PAGES dispatch on the
    // ?action= FORM VALUE inside the handlers, not the path — the module's
    // verified grammar). The raw/* byte arm claims in the EARLY `wiki`
    // block above (pages/wiki-raw.ts, the mounted raw bytes) → this arm
    // answers only the page shapes, the bare `/wiki/raw` included (chi's
    // wildcard-miss: the reserved-name 303 `?action=_pages` arm — that
    // behavior for the BARE tail is upstream parity and stays).
    let rawTail: string;
    try {
      rawTail = rest.map((segment) => decodeURIComponent(segment)).join("/");
    } catch {
      return null;
    }
    return { family: "wiki", owner, repo, rawTail };
  }
  if (head === "compare") {
    const bare: CompareRoute = {
      family: "compare",
      owner,
      repo,
      base: null,
      head: null,
      separator: "...",
      headOwner: null,
      headRepoName: null,
    };
    if (rest.length === 0) return bare;
    let suffix: string;
    try {
      suffix = rest.map((segment) => decodeURIComponent(segment)).join("/");
    } catch {
      return null;
    }
    if (suffix === "") return bare;
    // Window-2e B2: the .diff/.patch byte feeds (web.go:1309-1310) — claim
    // the suffixed tails BEFORE the page family returns (they would
    // otherwise fall into the single-ref family and 404 at resolution).
    if (suffix.endsWith(".diff")) {
      return { family: "compare-feed", owner, repo, ext: "diff", segment: suffix.slice(0, -5) };
    }
    if (suffix.endsWith(".patch")) {
      return { family: "compare-feed", owner, repo, ext: "patch", segment: suffix.slice(0, -6) };
    }
    // ParseCompareRouterParam (routers/common/compare.go:74-102): the FIRST
    // `...` splits; failing that, the first `..` (DirectComparison);
    // failing both, the whole tail is the HEAD (separator stays `...`).
    let separator: "..." | "..";
    let basePart: string;
    let headPart: string;
    const tri = suffix.indexOf("...");
    if (tri >= 0) {
      separator = "...";
      basePart = suffix.slice(0, tri);
      headPart = suffix.slice(tri + 3);
    } else {
      const bi = suffix.indexOf("..");
      if (bi >= 0) {
        separator = "..";
        basePart = suffix.slice(0, bi);
        headPart = suffix.slice(bi + 2);
      } else {
        separator = "...";
        basePart = "";
        headPart = suffix;
      }
    }
    // parseHead (compare.go:36-46) — the fork forms live on the HEAD part
    // only; the head REF is everything after the FIRST colon. A leading-
    // slash repo part (`/{repo}:{ref}`) is upstream's "head owner must be
    // specified" unsupported-syntax invalid-argument → the 404 class.
    let headOwner: string | null = null;
    let headRepoName: string | null = null;
    let headRef = headPart;
    const colon = headPart.indexOf(":");
    if (colon >= 0) {
      const ownerRepo = headPart.slice(0, colon);
      headRef = headPart.slice(colon + 1);
      const slash = ownerRepo.indexOf("/");
      if (slash > 0) {
        headOwner = ownerRepo.slice(0, slash);
        headRepoName = ownerRepo.slice(slash + 1);
      } else if (slash < 0) {
        headOwner = ownerRepo;
      } else {
        return null;
      }
      // parseHead's empty parts fold to upstream's simpler families: an
      // empty owner (`/:ref`) is the bare single-ref form, an empty repo
      // name (`{owner}/:{ref}`) is the bare `{owner}:{ref}` fork form
      // (GetHeadOwnerAndRepo branches on the empty strings).
      if (headOwner === "") headOwner = null;
      if (headRepoName === "") headRepoName = null;
    }
    // Refname impossibilities inside the sides (`..` never appears in a
    // refname; the BASE part never carries a fork form): unresolvable
    // upstream → the same 404 shell via null.
    if (basePart.includes("..") || basePart.includes(":") || headRef.includes("..")) return null;
    return {
      family: "compare",
      owner,
      repo,
      base: basePart === "" ? null : basePart,
      head: headRef === "" ? null : headRef,
      separator,
      headOwner,
      headRepoName,
    };
  }
  // Wave-16 branches family (pages/branches.tsx — upstream web.go:1478-1482's
  // group): the bare URL is the list; the `/delete` tail is the POST-only
  // write (the branch name rides the form field). Wave 39 lifts the group's
  // sibling `/list` literal out of the unclaimed set (web.go:1695 — the
  // branches aux JSON, pages/branches-list-aux.ts). Every other tail
  // (`/branches/abc`, upstream's `/_new/*` create + `/restore` writes, which
  // have no landed flows) stays engine-owned → the engine's 404.
  if (head === "branches") {
    if (rest.length === 0) return { family: "branches", owner, repo };
    if (rest.length === 1 && rest[0] === "delete") return { family: "branch-delete", owner, repo };
    if (rest.length === 1 && rest[0] === "list") return { family: "branches-list-aux", owner, repo };
    // Window-2e folds: the writer forms' POST targets (the wave-63 module's
    // handoff — upstream web.go:1477-1481/1486).
    if (rest.length >= 2 && rest[0] === "_new") {
      try {
        return {
          family: "branch-create",
          owner,
          repo,
          from: rest.slice(2).map((segment) => decodeURIComponent(segment)).join("/"),
        };
      } catch {
        return null;
      }
    }
    if (rest.length === 1 && rest[0] === "rename") return { family: "branch-rename", owner, repo };
    return null;
  }
  // Wave-20 releases family (pages/releases.tsx — upstream web.go:1505-1514's
  // group, the parity survey's #4): the bare URL is the list, `/new` the
  // create form + write, `/latest` the redirect, `/tag/{tail}` the single-
  // release page — the tail is the DECODED tag name with slashes preserved
  // (chi's `*` param; refnames carry slashes, so the emitted
  // `/releases/tag/v1.0/rc` links re-parse to the same route). Wave 33 (the
  // survey's top-5 #4) lifts the write group's `/edit/{tail}` (the same
  // wildcard decode — the URL-keyed tag) and `/delete` literals out of the
  // unclaimed set (web.go:1519-1520 + 1523). Wave 41 lifts the group's two
  // GET download routes out of the unclaimed set (web.go:1513-1514 — the
  // download-tail families below). The feed tails upstream registers
  // (`.rss`/`.atom` — the dotted-head claims just above), the
  // `/generate-notes` and the `/attachments`+`/attachments/remove` POST
  // write tails stay unclaimed → the engine's 404.
  // The releases feed twins (pages/releases-feed-xml.ts — upstream
  // web.go:1506-1507's `/{owner}/{repo}/releases.rss|.atom`): the dotted
  // head is a DISJOINT literal from the `releases` block below
  // (case-sensitively exact — `releases.RSS` and a ref named `releases.rss`
  // stay unclaimed → the engine's 404). Only the bare dotted head claims;
  // every deeper tail stays unclaimed exactly like the unregistered
  // upstream route.
  if (head === "releases.rss" || head === "releases.atom") {
    if (rest.length === 0) {
      return { family: head === "releases.rss" ? "release-feed-rss" : "release-feed-atom", owner, repo };
    }
    return null;
  }
  // The SPEC-0016 M2 repo packages tab (pages/packages.tsx — upstream's
  // `/{username}/{reponame}/packages` group's bare literal, web.go:1546's
  // `m.Group("/packages", repo.Packages)`): the bare URL only; the deeper
  // space stays unclaimed → the engine's 404 (upstream's group registers
  // no deeper web tail — the API family owns the registry protocol).
  if (head === "packages") {
    if (rest.length === 0) return { family: "repo-packages", owner, repo };
    return null;
  }
  if (head === "releases") {
    if (rest.length === 0) return { family: "releases", owner, repo };
    if (rest.length === 1 && rest[0] === "new") return { family: "release-new", owner, repo };
    if (rest.length === 1 && rest[0] === "latest") return { family: "release-latest", owner, repo };
    if (rest.length === 1 && rest[0] === "delete") return { family: "release-delete", owner, repo };
    if (rest.length >= 2 && rest[0] === "edit") {
      try {
        return {
          family: "release-edit",
          owner,
          repo,
          tag: rest.slice(1).map((segment) => decodeURIComponent(segment)).join("/"),
        };
      } catch {
        return null;
      }
    }
    if (rest.length >= 2 && rest[0] === "tag") {
      try {
        return {
          family: "release-detail",
          owner,
          repo,
          tag: rest.slice(1).map((segment) => decodeURIComponent(segment)).join("/"),
        };
      } catch {
        return null;
      }
    }
    // Wave-41 download tail (pages/release-downloads.ts — upstream
    // web.go:1513-1514's two GETs, the parity survey's top-5 #1): the
    // `/attachments/{uuid}` serve and the `/download/{vTag}/{fileName}`
    // redirect arm. BOTH are chi SINGLE-segment params (no wildcard — a
    // literal slash in the file name 404s upstream), so the claims are the
    // exact 3- and 4-segment shapes and every deeper tail stays unclaimed →
    // the engine's 404.
    if (rest.length === 2 && rest[0] === "attachments") {
      try {
        return { family: "release-attachment", owner, repo, uuid: decodeURIComponent(rest[1] as string) };
      } catch {
        return null;
      }
    }
    if (rest.length === 3 && rest[0] === "download") {
      try {
        return {
          family: "release-download",
          owner,
          repo,
          vTag: decodeURIComponent(rest[1] as string),
          fileName: decodeURIComponent(rest[2] as string),
        };
      } catch {
        return null;
      }
    }
    return null;
  }
  // Wave-41 rendered blob views (pages/render-files.ts — upstream
  // web.go:1715-1719's `/render` group, the survey's row 3): the three typed
  // ref sub-routes are the /src family's shape (the decoded ref+path suffix
  // over the SAME resolveRefSuffix universes, RepoRefByType's arms), the
  // `/blob/{sha}` arm is the exact 2-segment shape. A bare `/render`, an
  // unknown type literal, or deeper tails stay unclaimed → the engine's 404,
  // exactly upstream's unregistered-route answer.
  if (head === "render") {
    if (rest.length === 2 && rest[0] === "blob") {
      try {
        return { family: "render-file", owner, repo, sha: decodeURIComponent(rest[1] as string) };
      } catch {
        return null;
      }
    }
    if (rest.length >= 2 && (rest[0] === "branch" || rest[0] === "tag" || rest[0] === "commit")) {
      try {
        return {
          family: "render-file",
          owner,
          repo,
          refType: rest[0],
          refSuffix: rest.slice(1).map((segment) => decodeURIComponent(segment)).join("/"),
        };
      } catch {
        return null;
      }
    }
    return null;
  }
  // The RAW + MEDIA byte-serving families (pages/raw-files.ts — upstream
  // web.go:1699-1713's two groups, the survey's PARTIAL rows this wave
  // closes): the same three shapes the /render group claims, plus the
  // DEPRECATED catch-all upstream mounts as `m.Get("/*", RepoRefByType(""))`
  // — getRefNameLegacy's guess (branch → tag → 7..64-hex → the default-
  // branch fallback). The catch-all claims ≥1 segment: chi's `/*` wildcard
  // does not match the bare literal, so a bare `/raw`/`/media` stays
  // unclaimed → the engine's 404, exactly upstream. chi's
  // static-before-wildcard ranking (`/blob/{sha}` and the typed literals
  // beat `/*`) is the arm order below.
  if (head === "raw" || head === "media") {
    const family = head === "raw" ? "raw-file" : "media-file";
    if (rest.length === 2 && rest[0] === "blob") {
      try {
        return { family, owner, repo, sha: decodeURIComponent(rest[1] as string) };
      } catch {
        return null;
      }
    }
    if (rest.length >= 2 && (rest[0] === "branch" || rest[0] === "tag" || rest[0] === "commit")) {
      try {
        return {
          family,
          owner,
          repo,
          refType: rest[0],
          refSuffix: rest.slice(1).map((segment) => decodeURIComponent(segment)).join("/"),
        };
      } catch {
        return null;
      }
    }
    if (rest.length >= 1) {
      try {
        return { family, owner, repo, legacySuffix: rest.map((segment) => decodeURIComponent(segment)).join("/") };
      } catch {
        return null;
      }
    }
    return null;
  }
  // Wave-24 repo social lists (pages/repo-social.tsx — upstream's three bare
  // repo-scoped literals, web.go:1759 /forks + web.go:1766 /stars +
  // web.go:1767 /watchers, the survey bench's third-ranked row): exact
  // single-literal shapes, GET-only. Any deeper tail stays unclaimed → the
  // engine's 404, exactly upstream's unregistered-route answer. (The
  // singular `/fork` combo below is wave 26's — a distinct literal.)
  if (head === "forks" || head === "stars" || head === "watchers") {
    if (rest.length === 0) return { family: head, owner, repo };
    return null;
  }
  // The census R10 in-repo code search (pages/repo-search.tsx — upstream
  // web.go:1768's bare literal, registered in THIS SAME group as the social
  // trio: `m.Get("/search", reqUnitCodeReader, repo.Search)` at
  // web.go:1766): the exact bare literal, GET-only. The query arms ride the
  // URL (?q, ?search_mode, ?page, our ?path pathspec passthrough), so any
  // deeper tail stays unclaimed → the engine's 404, exactly upstream's
  // unregistered-route answer.
  if (head === "search") {
    if (rest.length === 0) return { family: "repo-search", owner, repo };
    return null;
  }
  // The census R09-M2 commit graph (pages/repo-graph.tsx — upstream
  // web.go:1738's bare `/graph` literal in the MustBeNotEmpty group at
  // web.go:1737-1744): the exact bare literal, GET-only — no ref-suffix
  // middleware exists upstream, so no deeper tail claims (the query arms
  // mode/hide-pr-refs/branch/div-only/page ride the URL).
  if (head === "graph") {
    if (rest.length === 0) return { family: "graph", owner, repo };
    return null;
  }
  // Wave-26 fork form (pages/repo-fork.tsx — upstream web.go:1490's
  // `m.Combo("/fork").Get(repo.Fork).Post(...)`, the survey's TOP-5 row):
  // the exact bare literal, GET the form + POST the landed createFork
  // sequence (the signed-in gate and the empty-source 404 run at the
  // handlers, upstream reqSignIn + getForkRepository's IsEmpty arm). Deeper
  // tails stay unclaimed → the engine's 404.
  if (head === "fork") {
    if (rest.length === 0) return { family: "repo-fork", owner, repo };
    return null;
  }
  // Wave-25 tags family (pages/tags.tsx — upstream web.go:1493-1496's
  // `/tags` group's list route, the survey's TOP-1 row): the exact bare
  // literal. Wave 33 (the survey's top-5 #2) lifts the group's other two
  // routes out of the unclaimed set: `/tags/list` the aux JSON (web.go:1499,
  // pages/tag-list-aux.ts) and `/tags/delete` the delete write (web.go:1501,
  // POST-only — GET answers chi's 405). The `.rss`/`.atom` feed tails are
  // the dotted-head claims just above and every deeper tail stays unclaimed
  // → the engine's 404, exactly upstream's unregistered-route answer.
  // The tags feed twins (pages/tags-feed-xml.ts — upstream web.go:1495-1496's
  // `/{owner}/{repo}/tags.rss|.atom`): the dotted head is a DISJOINT literal
  // from the `tags` block below; only the bare dotted head claims.
  if (head === "tags.rss" || head === "tags.atom") {
    if (rest.length === 0) {
      return { family: head === "tags.rss" ? "tags-feed-rss" : "tags-feed-atom", owner, repo };
    }
    return null;
  }
  if (head === "tags") {
    if (rest.length === 0) return { family: "tags", owner, repo };
    if (rest.length === 1 && rest[0] === "list") return { family: "tags-list-aux", owner, repo };
    if (rest.length === 1 && rest[0] === "delete") return { family: "tags-delete", owner, repo };
    return null;
  }
  // Wave-25 repo labels families (pages/repo-labels.tsx — upstream
  // web.go:1338's page + web.go:1417-1422's three POST segments, the
  // survey's TOP-2 row): the bare literal is the list; the write tails are
  // upstream's exact segments (the write gate runs at the handlers). The
  // third-segment position never collides with the wave-14 org literal
  // (that one claims `labels` as the SECOND segment, shadowing a repository
  // named "labels" exactly like upstream's own route order). The
  // `/labels/initialize` template loader and every deeper tail stay
  // unclaimed → the engine's 404.
  if (head === "labels") {
    if (rest.length === 0) return { family: "repo-labels", owner, repo };
    if (rest.length === 1) {
      if (rest[0] === "new") return { family: "repo-label-new", owner, repo };
      if (rest[0] === "edit") return { family: "repo-label-edit", owner, repo };
      if (rest[0] === "delete") return { family: "repo-label-delete", owner, repo };
    }
    return null;
  }
  // Wave-45 repo projects families (pages/repo-projects.tsx — upstream
  // web.go:1544-1563's group, the survey's re-ranked #1; the wave-40 flip
  // kept these repo-scoped shapes unclaimed until this wave): the bare
  // literal is the list; `/new` the write group's form combo (registered
  // ahead of the {id} param upstream — chi static-before-dynamic); the {id}
  // shapes claim positive integers only (the owner-board families'
  // PathParamInt64 parity — "007" parses as 7; junk segments stay
  // engine-owned where upstream's PathParamInt64-zero arm would
  // ServerError). The PUT/DELETE board-helper arms (`/{columnID}`) and the
  // drag-drop JSON arms (`/move`, `/{columnID}/move`) stay unclaimed → the
  // engine's 404; every deeper tail likewise.
  if (head === "projects") {
    if (rest.length === 0) return { family: "repo-projects", owner, repo };
    if (rest.length === 1 && rest[0] === "new") return { family: "repo-project-new", owner, repo };
    if (/^\d+$/.test(rest[0] as string)) {
      const id = Number.parseInt(rest[0] as string, 10);
      if (rest.length === 1) return { family: "repo-project-board", owner, repo, id };
      if (rest.length === 2) {
        if (rest[1] === "edit") return { family: "repo-project-edit", owner, repo, id };
        if (rest[1] === "delete") return { family: "repo-project-delete", owner, repo, id };
        if (rest[1] === "open") return { family: "repo-project-status", owner, repo, id, action: "open" };
        if (rest[1] === "close") return { family: "repo-project-status", owner, repo, id, action: "close" };
        if (rest[1] === "workflows") return { family: "repo-project-workflows", owner, repo, id };
      }
      if (rest.length === 3) {
        if (rest[1] === "columns" && rest[2] === "new") {
          return { family: "repo-project-column-new", owner, repo, id };
        }
        if (rest[1] === "workflows" && /^\d+$/.test(rest[2] as string)) {
          return {
            family: "repo-project-workflows",
            owner,
            repo,
            id,
            workflowId: Number.parseInt(rest[2] as string, 10),
          };
        }
        if (/^\d+$/.test(rest[1] as string) && rest[2] === "default") {
          return {
            family: "repo-project-column-default",
            owner,
            repo,
            id,
            columnId: Number.parseInt(rest[1] as string, 10),
          };
        }
      }
      if (
        rest.length === 4 &&
        rest[1] === "workflows" &&
        /^\d+$/.test(rest[2] as string) &&
        rest[3] === "delete"
      ) {
        return {
          family: "repo-project-workflow-delete",
          owner,
          repo,
          id,
          workflowId: Number.parseInt(rest[2] as string, 10),
        };
      }
    }
    return null;
  }
  // Wave-18 commit view (pages/commit-view.tsx — upstream web.go:1739): the
  // exact single-segment tail only, claimed for ANY segment value so a
  // non-hex sha 404-shells through the loader (the brief's rule) instead of
  // reaching the engine. Deeper tails are lifted by their own wave families
  // (the `.{patch|diff}` downloads below, wave-32's `/load-branches-and-
  // tags` aux JSON); junk stays engine-owned, and the bare `/commit` falls
  // through to the engine's 404 — upstream's own shape.
  if (head === "commit") {
    if (rest.length !== 1 && rest.length !== 2) return null;
    let sha: string;
    try {
      sha = decodeURIComponent(rest[0] as string);
    } catch {
      return null;
    }
    // Wave-32 (the survey's row 3): the aux-JSON tail `/load-branches-and-
    // tags` — upstream web.go:1740's
    // `{sha:([a-f0-9]{7,64})}/load-branches-and-tags` route lifts the
    // HEX-shaped 5-segment shape out of the view family (the case folding
    // is the landed COMMIT_SHA convention; a non-hex sha with the literal
    // tail is upstream's pattern miss → engine-owned; the loader re-gates
    // the shape).
    if (rest.length === 2) {
      if (rest[1] !== "load-branches-and-tags" || !/^[0-9a-f]{7,64}$/i.test(sha)) return null;
      return { family: "commit-contained-refs", owner, repo, sha };
    }
    // Wave-29 (the survey's row 4): the raw-text download tails
    // `{sha}.{diff|patch}` — upstream web.go:1760's
    // `{sha:([a-f0-9]{7,64})}.{ext:patch|diff}` route lifts the hex-shaped
    // dotted segment into the download family (the case folding is the
    // landed COMMIT_SHA convention); every other segment keeps the wave-18
    // commit-view claim (a non-hex `foo.diff` 404-shells there, upstream's
    // pattern-miss answer).
    const dotted = /^([0-9a-f]{7,64})\.(diff|patch)$/i.exec(sha);
    if (dotted !== null) {
      return {
        family: "commit-diffpatch",
        owner,
        repo,
        sha: dotted[1] as string,
        ext: dotted[2] as "diff" | "patch",
      };
    }
    return { family: "commit-view", owner, repo, sha };
  }
  // Wave-32 archive download (pages/archive-files.ts — upstream web.go:1689):
  // the `/archive/*` wildcard claims every tail INCLUDING the bare URL (chi's
  // `/*` matches the empty tail and `SplitArchiveNameType("")` is the route's
  // 400 arm — the loader's bad-format answer). The tail is the DECODED
  // `{ref}.{zip|tar.gz}` with slashes preserved (multi-segment ref names
  // re-parse to the same route, the release-detail tag convention); the
  // format/ref gates run at the loader. The POST half (InitiateDownload,
  // web.go:1690) stays engine-owned — GET only, the survey's page-bearing
  // rule.
  if (head === "archive") {
    let refExt: string;
    try {
      refExt = rest.map((segment) => decodeURIComponent(segment)).join("/");
    } catch {
      return null;
    }
    return { family: "repo-archive", owner, repo, refExt };
  }
  // Wave-8 file editor: the `new`/`edit`/`delete` literals claim the
  // branch+path tail shape (FileEditorRoute). Bare literals fall through to
  // the engine (upstream chi requires the `/*` tail as well).
  if (head === "new" || head === "edit" || head === "delete" || head === "upload") {
    if (rest.length === 0) return null;
    let suffix: string;
    try {
      suffix = rest.map((segment) => decodeURIComponent(segment)).join("/");
    } catch {
      return null;
    }
    return {
      family: head === "new" ? "file-new" : head === "edit" ? "file-edit" : head === "delete" ? "file-delete" : "file-upload",
      owner,
      repo,
      refSuffix: suffix,
    };
  }
  // Window-2e C2b: the cherrypick/patch pages (web.go:1465-1470 — the sha
  // rides the cherrypick ROUTE between the literal and the branch tail;
  // bare patch/{branch} is the patch family). Bare literals fall through.
  if (head === "patch" || head === "cherrypick") {
    if (rest.length === 0) return null;
    let suffix: string;
    try {
      suffix = rest.map((segment) => decodeURIComponent(segment)).join("/");
    } catch {
      return null;
    }
    if (head === "patch") return { family: "editor-patch", owner, repo, refSuffix: suffix };
    if (splitCherryPickSuffix(suffix) === null) return null;
    return { family: "editor-cherrypick", owner, repo, refSuffix: suffix };
  }
  let suffix: string;
  try {
    suffix = rest.map((segment) => decodeURIComponent(segment)).join("/");
  } catch {
    return null;
  }
  // The blame page family (web.go:1729-1733's /blame/{branch,tag,commit}/*):
  // the typed tails claim every rest INCLUDING a bare refType (chi's `/*`
  // matches the empty tail after /blame/branch — RefBlame resolves the ref
  // and its empty-TreePath arm NotFounds, which the loader's splitRefSuffix
  // walk reproduces as the 404 shell). The bare `/blame` is unclaimed — no
  // upstream route (the editor-literal convention), the engine answers.
  if (head === "blame") {
    if (rest.length === 0) return null;
    return { family: "blame", owner, repo, refSuffix: suffix };
  }
  if (head === "commits") return { family: "commits", owner, repo, refSuffix: rest.length > 0 ? suffix : null };
  if (head === "src") return { family: "src", owner, repo, refSuffix: rest.length > 0 ? suffix : null };
  return null;
}

/** The dispatcher gate (§2.2): `true` = the request belongs to a UI page
 *  family and must be answered by `uiRouter`, never the engine. */
export function handlesUiRoute(pathname: string): boolean {
  return parseUiRoute(pathname) !== null;
}

// ---------------------------------------------------------------------------
// Ref-suffix resolution (§3.3) — upstream's URL-path ref rules, ported
// from `RepoRefByType`/`getRefName` (gitea/services/context/repo.go:833-935).
// Pure functions: U3's page-data layer supplies `listRefs()` output.
// ---------------------------------------------------------------------------

/** The ref-type prefix `/{src,commits}/` URLs carry (§3.3: required, as
 *  upstream's explicit `/branch|tag|commit/*` routes; the legacy no-prefix
 *  form is not claimed — it 404-shells instead). */
export type RefType = "branch" | "tag" | "commit";

/** Split the family suffix into its ref-type prefix and the ref+path rest.
 *  `null` = no (or a non-exact) prefix → 404 shell (§3.3). */
export function splitRefSuffix(suffix: string): { refType: RefType; rest: string } | null {
  for (const refType of ["branch", "tag", "commit"] as const) {
    if (suffix === refType) return { refType, rest: "" };
    if (suffix.startsWith(`${refType}/`)) return { refType, rest: suffix.slice(refType.length + 1) };
  }
  return null;
}

/** The ref name universe of one repository — `listRefs()` output plus the D1
 *  default branch (§4.9: unborn/broken HEAD falls back to that convention). */
export interface RefSuffixRefs {
  branches: readonly string[];
  tags: readonly string[];
  defaultBranch: string;
}

/** A resolved ref suffix: how the URL labeled it, the ref (branch/tag name,
 *  or the request's own sha prefix for `commit`), and the tree path under it. */
export interface ResolvedRefSuffix {
  refType: RefType;
  ref: string;
  treePath: string;
}

/** Upstream `getRefName` commit branch: `IsStringValidObjectID(fmt, part, 7)`
 *  — 7..64 hex, no existence check at parse time (upstream FIXME preserved;
 *  the engine readCommit resolves it in U3). */
const COMMIT_SHA = /^[0-9a-f]{7,64}$/i;

/** The default branch to use when the URL carries no ref: the D1 default
 *  branch when it exists, else the first branch — upstream
 *  `RepoRefByType`'s `GetBranchNames(0, 1)` fallback (repo.go:964-971). */
function defaultBranchOf(refs: RefSuffixRefs): string | null {
  if (refs.branches.includes(refs.defaultBranch)) return refs.defaultBranch;
  return refs.branches[0] ?? null;
}

/**
 * Resolve a decoded ref+path suffix against a repository's refs. Semantics
 * (upstream `getRefNameFromPath`, repo.go:833-845):
 *
 * - The ref may bear slashes; the SHORTEST existing cumulative prefix wins
 *   (first match walking left to right) and the remainder is the tree path —
 *   so `feature/foo/README.md` with branch `feature/foo` is (ref
 *   `feature/foo`, tree `README.md`), and with branches `feature` AND
 *   `feature/foo` the shorter one wins, exactly upstream.
 * - An empty rest resolves to the default branch regardless of the declared
 *   prefix (upstream's `reqPath == ""` branch, repo.go:962-980).
 * - `branch` + literal `HEAD` → the default branch (repo.go:875-881). A
 *   branch actually named `HEAD` wins first via the walk.
 * - `commit` + literal `HEAD` → null here: upstream swaps in the default
 *   branch's commit id, which needs an engine round-trip — U3's page-data
 *   layer owns that resolution, and until then the caller 404-shells it.
 * - Anything unresolvable → null → 404 shell (§3.3, §4.5).
 */
export function resolveRefSuffix(refType: RefType, rest: string, refs: RefSuffixRefs): ResolvedRefSuffix | null {
  const parts = rest === "" ? [] : rest.split("/");

  if (parts.length === 0) {
    const fallback = defaultBranchOf(refs);
    return fallback === null ? null : { refType: "branch", ref: fallback, treePath: "" };
  }

  const walk = (names: readonly string[]): ResolvedRefSuffix | null => {
    const set = new Set(names);
    for (let i = 0; i < parts.length; i++) {
      const candidate = parts.slice(0, i + 1).join("/");
      if (set.has(candidate)) {
        return { refType, ref: candidate, treePath: parts.slice(i + 1).join("/") };
      }
    }
    return null;
  };

  switch (refType) {
    case "branch": {
      const hit = walk(refs.branches);
      if (hit !== null) return hit;
      if (parts[0] === "HEAD") {
        const fallback = defaultBranchOf(refs);
        if (fallback !== null) return { refType: "branch", ref: fallback, treePath: parts.slice(1).join("/") };
      }
      return null;
    }
    case "tag":
      return walk(refs.tags);
    case "commit": {
      const sha = parts[0] as string;
      if (COMMIT_SHA.test(sha)) return { refType: "commit", ref: sha, treePath: parts.slice(1).join("/") };
      return null; // incl. HEAD — needs the engine (see doc comment)
    }
  }
}

// ---------------------------------------------------------------------------
// Assets seam (§2.3.4)
// ---------------------------------------------------------------------------

/** Structural type of the Workers static-assets fetcher binding, as read by
 *  `loadManifest`. Declared here (not taken from the generated Env) because
 *  the wrangler.jsonc `assets` block is the orchestrator's U1 wiring — until
 *  it lands, `Env` legitimately has no ASSETS member and the binding is
 *  absent at runtime, which is exactly the 503 path below. */
export interface UiAssetsFetcher {
  fetch(input: RequestInfo): Promise<Response>;
}

function isAssetsFetcher(value: unknown): value is UiAssetsFetcher {
  return typeof value === "object" && value !== null && "fetch" in value;
}

/** Read `env.ASSETS` without assuming the U1 wrangler wiring: the generated
 *  Env gains the member when the assets block lands (then `wrangler types`);
 *  until then this returns `undefined` → `AssetBuildError` → the 503. The
 *  `in` check narrows the unlisted member to `unknown` (TS 4.9+); the shape
 *  guard keeps a stray non-fetcher binding from reaching loadManifest. */
export function assetsBinding(env: Pick<Env, "ASSETS">): UiAssetsFetcher | undefined {
  if ("ASSETS" in env) {
    const binding: unknown = env.ASSETS;
    if (isAssetsFetcher(binding)) return binding;
  }
  return undefined;
}

/**
 * The §2.3.4 failure mode: a missing manifest, missing required entry, or
 * absent binding fails fast with 503 plain text instead of a broken page.
 * Git and API routes never pass through the shell (the assets config and the
 * dispatcher own those paths), so they are unaffected. Same plain-text shape
 * as the gate's error responses (`plainTextInternal`).
 */
export function assetsNotBuilt(error: AssetBuildError): Response {
  return new Response(`${error.message}\n`, {
    status: 503,
    headers: { "content-type": "text/plain;charset=utf-8", "x-content-type-options": "nosniff" },
  });
}

// ---------------------------------------------------------------------------
// uiRouter (§2.2 — the orchestrator mounts this at the dispatcher)
// ---------------------------------------------------------------------------

/** Narrow the parsed union back to the slice-1 route `renderUiPage` consumes
 *  (the two wave-2 dispatch branches above returned for every other member). */
function isSliceOneRoute(route: ParsedUiRoute): route is UiRoute {
  return route.family === "home" || route.family === "commits" || route.family === "src";
}

// ---------------------------------------------------------------------------
// Shared handler prologue + the wave-4 write handlers (§2.2)
// ---------------------------------------------------------------------------

/** The resolved parts every uiRouter handler shares (the §2.3.4 manifest
 *  load, the SPEC-0010 §2.5 viewer resolution and its Set-Cookie plumbing).
 *  `ok: false` carries the ready Response: the 503 assets failure or the
 *  null-parse 404 (registration/parser drift or a trailing slash — the
 *  middleware below 301s those). Repo-scoped handlers stack the §2.5 repo
 *  read on top (`ResolvedUiRequest`); the org home resolves an ORG instead
 *  (pages/org-home.tsx). */
type ResolvedUiSession =
  | {
      ok: true;
      url: URL;
      route: ParsedUiRoute;
      ctx: UiContext;
      viewer: Viewer;
      /** Attach the resolution's Set-Cookie directive (§2.4) when directed. */
      respond: (res: Response) => Response;
    }
  | { ok: false; response: Response };

async function resolveUiSession(c: Context<{ Bindings: Env }>): Promise<ResolvedUiSession> {
  const url = new URL(c.req.url);
  const route = parseUiRoute(url.pathname);
  // Only reachable through registration/parser drift or a trailing slash
  // (the middleware below turns the trailing-slash 404 into the canonical
  // 301) — never render the shell for a path the parser does not claim.
  if (route === null) return { ok: false, response: await c.notFound() };

  // SPEC-0010 §2.5 viewer resolution (the session wave's transition note in
  // viewer.ts): the session cookie is verified per request and every
  // response carries the rotation Set-Cookie when one is directed.
  // `c.executionCtx` is unavailable under direct `router.fetch` invocations
  // (the tests) — the resolver then settles its background work inline.
  let waitUntil: ((promise: Promise<unknown>) => void) | undefined;
  try {
    waitUntil = c.executionCtx.waitUntil.bind(c.executionCtx);
  } catch {
    waitUntil = undefined;
  }
  let ctx: UiContext;
  let setCookie: string | null = null;
  let viewer: Viewer;
  try {
    const manifest = await loadManifest(assetsBinding(c.env), url.origin);
    const resolution = await resolveViewer(c.env, c.req.raw, { waitUntil });
    // resolveViewer's setCookie is the RAW session value (id:secret) on
    // resolveViewer's setCookie is ALWAYS a full §2.7 directive now (the
    // rotation arm wraps there) — attach as-is. The old unconditional
    // re-wrap double-wrapped the clear arm's already-complete directive
    // (the dashboard matrix's RED).
    setCookie = resolution.setCookie;
    viewer = resolution.viewer;
    // The wave-10 navbar bell's unread count (head_navbar_icons.tmpl's
    // `.notification_count`): the derived-thread COUNT per signed-in request
    // — the same one-query cost upstream's PageGlobalData carries
    // (pages/notifications.tsx header). A failed read degrades to null (the
    // badge renders hidden — upstream NewAvailable's {new: 0} error arm).
    let notificationCount: number | null = null;
    if (viewer.kind === "user") {
      try {
        notificationCount = await countUnreadNotifications(c.env.DB, viewer.id);
      } catch {
        notificationCount = null;
      }
    }
    ctx = {
      viewer: resolution.viewer,
      origin: url.origin,
      notificationCount,
      demoMode: demoModeEnabled(c.env),
      // The SPEC-0016 M2 global quota arm (PACKAGES_ENABLED, the strict
      // polarity — absent/"true" arms, "false" drops): the profile page's
      // Packages tab anchor and the R04 subtree's route gate read it.
      packagesEnabled: packagesQuotaFromEnv(c.env).packagesEnabled,
      assets: shellAssetsFromManifest(manifest),
    };
  } catch (error) {
    if (error instanceof AssetBuildError) return { ok: false, response: assetsNotBuilt(error) };
    throw error;
  }
  const respond = (res: Response): Response => {
    if (setCookie === null) return res;
    const headers = new Headers(res.headers);
    headers.append("set-cookie", setCookie);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  };
  return { ok: true, url, route, ctx, viewer, respond };
}

type ResolvedUiRequest = Extract<ResolvedUiSession, { ok: true }> & { repo: RepoRow };

/**
 * The repo-scoped prologue: the shared session half, then the §2.5 repo
 * read — SPEC-0010 §2.6: the read widens through the gate's own grant lines
 * (shared readGrant predicate) — anonymous keeps the row-1 collapse
 * verbatim, a session viewer gains the authenticated read paths; anything
 * without a grant 404-shells exactly as before (existence stays hidden).
 */
async function resolveUiRequest(c: Context<{ Bindings: Env }>): Promise<ResolvedUiRequest | { ok: false; response: Response }> {
  const resolved = await resolveUiSession(c);
  if (!resolved.ok) return resolved;
  // The owner-home family has no repo segment — only reachable through
  // registration drift (neither page handler calls this).
  const route = resolved.route;
  if (!("repo" in route)) return { ok: false, response: resolved.respond(await c.notFound()) };
  const repo = await resolveRepositoryForViewer(c.env, resolved.viewer, route.owner, route.repo);
  if (repo === null) return { ok: false, response: resolved.respond(c.html(renderNotFound(resolved.ctx), 404)) };
  resolved.ctx.repo = repo;
  // The Projects unit toggle (wave-45 — repo_settings.has_projects, the
  // landed store's MustEnableRepoProjects reduction): one PK read per
  // repo-scoped request. The shell's Projects tab (upstream repo/header.
  // tmpl:146-154 gates the tab on the SAME unit condition) and the
  // /projects group's handlers both read this flag.
  // The Packages unit toggle rides the SAME read (SPEC-0016 M2 —
  // repo_settings.has_packages, the R16 gate): the shell's Packages tab
  // and the /packages tab handler read this flag (the has_projects
  // pattern).
  const settings = await loadRepoSettings(c.env.DB, repo.id);
  resolved.ctx.repoHasProjects = settings.hasProjects;
  resolved.ctx.repoHasPackages = settings.hasPackages;
  // The Actions unit toggle (SPEC-0012 M1c C1 — repo_settings.has_actions,
  // the repoHasPackages twin): the shell's Actions tab (repo/header.tmpl:
  // 130-139's unit conditional) reads this flag; the /actions handler
  // re-reads the store for its MustEnableActions 404 arm (the C8 gate's
  // polarity).
  resolved.ctx.repoHasActions = settings.hasActions;
  return { ...resolved, repo };
}

/**
 * The authed-page redirect (SPEC-0010 §2.5, the session wave's convention):
 * an anonymous viewer 303s onto the login form with this request URI as the
 * `redirect_to` round-trip target — the FULL `pathname + search` (Go's
 * `req.URL.RequestURI()`), exactly what upstream's middleware carries
 * (modules/web/middleware/cookie.go RedirectLinkUserLogin, consumed by
 * reqSignIn at routers/web/web.go) — and the session router re-validates it
 * through `safeRedirectTarget` at use time. Repo resolution happens FIRST,
 * so an invisible repo 404-shells and never reveals itself through the
 * redirect.
 */
function loginRedirect(requestUri: string): Response {
  return new Response(null, {
    status: 303,
    headers: { location: `/login?redirect_to=${encodeURIComponent(requestUri)}` },
  });
}

/** GET /{owner}/{repo}/issues/new (pages/new-issue.tsx): the form for the
 *  signed-in viewer; anonymous 303s onto the login round-trip. Wave 26: the
 *  milestone-detail page's New Issue link preselects its milestone
 *  (`?milestone=` — upstream NewIssue's FormInt64("milestone"); a
 *  non-numeric or unknown id falls through to none, the form's own
 *  parsing). */
async function issueNewChoosePage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const { repo, url, respond } = resolved;
  return respond(issueNewChooseRedirect(repo, url));
}

async function issueNewPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const { url, ctx, viewer, repo, respond } = resolved;
  if (viewer.kind === "anonymous") return respond(loginRedirect(url.pathname + url.search));
  const data = await loadNewIssueData(c.env.DB, repo.id);
  const milestoneParam = (url.searchParams.get("milestone") ?? "").trim();
  const milestoneId =
    /^\d+$/.test(milestoneParam) && Number.parseInt(milestoneParam, 10) > 0
      ? Number.parseInt(milestoneParam, 10)
      : null;
  return respond(
    c.html(
      renderNewIssuePage({
        ctx,
        data,
        form: { title: "", content: "", labelIds: [], milestoneId },
        error: null,
      }),
      200,
    ),
  );
}

/**
 * POST /{owner}/{repo}/issues/new (upstream NewIssuePost): the §2.8 layer-2
 * Origin guard, then the same repo→viewer order as the GET (invisible repos
 * 404 before the redirect could leak them), then the tier-1
 * `IssuesService.createIssue` — success 303s onto the created issue's detail
 * page (upstream `ctx.Redirect(issue.Link())`, 303 per base.go:157),
 * validation failures re-render the form at 200 with the message and the
 * submitted values (the login failure convention).
 */
async function issueNewSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const { url, ctx, viewer, repo, respond } = resolved;
  if (viewer.kind === "anonymous") return respond(loginRedirect(url.pathname + url.search));
  const form = await readNewIssueForm(c.req.raw);
  // Archived repos refuse the write (the API create route's
  // assertNotArchived posture — the message cites it verbatim).
  if (repo.isArchived) {
    const data = await loadNewIssueData(c.env.DB, repo.id);
    return respond(c.html(renderNewIssuePage({ ctx, data, form, error: newIssueLocale.repo_archived }), 200));
  }
  // The emission hook rides the write (services/issue-events.ts): the SAME
  // issues "opened" fan-out the API POST route emits — the wave-4 divergence.
  const result = await createIssueFromForm(c.env.DB, repo.id, form, viewer.id, { request: c, origin: ctx.origin });
  const repoLink = `/${repo.ownerNamespace}/${repo.slug}`;
  if (result.outcome === "created") {
    return respond(new Response(null, { status: 303, headers: { location: `${repoLink}/issues/${result.issue.index}` } }));
  }
  const data = await loadNewIssueData(c.env.DB, repo.id);
  return respond(c.html(renderNewIssuePage({ ctx, data, form, error: result.message }), 200));
}

/** The settings admin gate (pages/settings.tsx header): anonymous → the
 *  login 303; a signed-in non-admin → the 404 shell (upstream settings
 *  pages are admin-only and equally undiscoverable). The grant rides the
 *  landed `isRepositoryAdmin` (repo-access.ts via ../repo-grants.ts — team
 *  grants included). Returns the Response to answer, or `null` to proceed. */
async function settingsGate(
  c: Context<{ Bindings: Env }>,
  resolved: Extract<ResolvedUiRequest, { ok: true }>,
): Promise<Response | null> {
  const { url, ctx, viewer, repo, respond } = resolved;
  if (viewer.kind === "anonymous") return respond(loginRedirect(url.pathname + url.search));
  if (!(await canAdminRepo(c.env, repo, viewer))) return respond(c.html(renderNotFound(ctx), 404));
  return null;
}

/** GET /{owner}/{repo}/settings (pages/settings.tsx — the basics form). */
async function settingsPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const gate = await settingsGate(c, resolved);
  if (gate !== null) return gate;
  const data = await loadRepoBasics(c.env.DB, resolved.repo);
  return resolved.respond(c.html(renderRepoSettingsPage({ ctx: resolved.ctx, data, error: null }), 200));
}

/** POST /{owner}/{repo}/settings — the basics write through the landed
 *  services (RepoService.rename/setVisibility + saveRepoSettings); success
 *  303s back onto the CANONICAL settings URL (a rename moves the slug). */
async function settingsSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const gate = await settingsGate(c, resolved);
  if (gate !== null) return gate;
  const { ctx, repo, respond } = resolved;
  const form = parseRepoBasicsForm(await readUrlEncodedForm(c.req.raw));
  const result = await applyRepoBasics(c.env.DB, repo, form);
  if (result.outcome === "applied") {
    return respond(new Response(null, { status: 303, headers: { location: `/${repo.ownerNamespace}/${result.slug}/settings` } }));
  }
  const data = await loadRepoBasics(c.env.DB, repo);
  // The whole parsed form carries (88cbd17's hardening): the optional
  // fields' stored-fallbacks in the module become dead code — the invalid
  // re-render now shows exactly what was submitted (secrets-class fields
  // never ride; this form has none).
  data.form = form;
  return respond(c.html(renderRepoSettingsPage({ ctx, data, error: result.message }), 200));
}

// ---------------------------------------------------------------------------
// Window-2d: the four settings-tab modules (githooks, protected tags,
// deploy keys, public access) — the shared settingsGate posture, drift
// guards per family, sameOriginGuard-first POSTs.
// ---------------------------------------------------------------------------

async function repoGitHooksPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const gate = await settingsGate(c, resolved);
  if (gate !== null) return gate;
  const { respond } = resolved;
  if (resolved.route.family !== "settings-githooks") return respond(await c.notFound()); // drift guard
  // c.env.DB rides the loader's optional seam — the nav's conditional Actions
  // block flag (navbar.tmpl:47; loadRepoGitHooks's producer note).
  const data = await loadRepoGitHooks(c.env.REPO_PACKS, resolved.repo, c.env.DB);
  return respond(c.html(renderRepoGitHooksListPage({ ctx: resolved.ctx, data }), 200));
}

async function repoGitHookEditPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const gate = await settingsGate(c, resolved);
  if (gate !== null) return gate;
  const { ctx, respond } = resolved;
  const route = resolved.route;
  if (route.family !== "settings-githook" || route.name === undefined) return respond(await c.notFound()); // drift guard
  // ErrNotValidHook → the 404 shell (the module handoff). c.env.DB rides the
  // loader's optional seam — the nav's Actions flag (navbar.tmpl:47).
  const data = await loadRepoGitHookEdit(c.env.REPO_PACKS, resolved.repo, route.name, c.env.DB);
  if (data === null) return respond(c.html(renderNotFound(ctx), 404));
  return respond(c.html(renderRepoGitHookEditPage({ ctx, data }), 200));
}

async function repoGitHookSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const gate = await settingsGate(c, resolved);
  if (gate !== null) return gate;
  const { repo, respond } = resolved;
  const route = resolved.route;
  if (route.family !== "settings-githook" || route.name === undefined) return respond(await c.notFound()); // drift guard
  const form = parseRepoGitHookForm(await readUrlEncodedForm(c.req.raw));
  // c.env.DB rides the loader's optional seam — the nav's Actions flag.
  const data = await loadRepoGitHookEdit(c.env.REPO_PACKS, repo, route.name, c.env.DB);
  if (data === null) return respond(c.html(renderNotFound(resolved.ctx), 404));
  await applyRepoGitHook(c.env.REPO_PACKS, repo, route.name, form);
  return respond(new Response(null, { status: 303, headers: { location: `${repoLinkOf(repo)}/settings/hooks/git` } }));
}

async function repoTagsPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const gate = await settingsGate(c, resolved);
  if (gate !== null) return gate;
  const { ctx, repo, respond, url } = resolved;
  if (resolved.route.family !== "settings-tags") return respond(await c.notFound()); // drift guard
  const editParam = url.searchParams.get("id");
  const editId = editParam !== null && /^\d+$/.test(editParam) ? Number.parseInt(editParam, 10) : null;
  const row = editId === null ? null : await loadTagRuleById(c.env.DB, repo.id, editId);
  const data = {
    rules: await loadProtectedTagRules(c.env.DB, repo),
    isOrg: await loadOwnerIsOrg(c.env.DB, repo),
    form: row !== null ? await editFormOfTag(c.env.DB, row) : emptyTagProtectionForm(),
    editing: row,
    saved: url.searchParams.get("saved") === "1",
    // The nav's conditional Actions block flag (navbar.tmpl:47 — the
    // settings.tsx hasActions prop).
    hasActions: (await loadRepoSettings(c.env.DB, repo.id)).hasActions,
  };
  return respond(c.html(renderTagProtectionPage({ ctx, data, error: null }), 200));
}

async function repoTagsSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const gate = await settingsGate(c, resolved);
  if (gate !== null) return gate;
  const { ctx, repo, respond } = resolved;
  const route = resolved.route;
  if (route.family !== "settings-tags" && route.family !== "settings-tag-detail") return respond(await c.notFound()); // drift guard
  if (route.family === "settings-tag-detail" && route.id === undefined) return respond(await c.notFound());
  // RepoMustNotBeArchived rides the POSTs (web.go:1216-1220).
  if (repo.isArchived) return respond(c.html(renderNotFound(ctx), 404));
  const pair = await findRepositoryById(c.env.DB, repo.id);
  if (pair === null) return respond(c.html(renderNotFound(ctx), 404));
  const form = parseTagProtectionForm(await readUrlEncodedForm(c.req.raw));
  // Upstream keys the EDIT by the URL path id (m.Post("/{id}") →
  // selectProtectedTagByContext), not a hidden field — the rendered form
  // carries none. Inject the route id (the module header's contract note;
  // the tags matrix's RED witness).
  if (route.family === "settings-tag-detail" && route.id !== undefined) form.id = route.id;
  const result = await applyTagProtectionForm(c.env.DB, pair, form);
  if (result.outcome === "created" || result.outcome === "saved") {
    return respond(new Response(null, { status: 303, headers: { location: `${repoLinkOf(repo)}/settings/tags?saved=1` } }));
  }
  if (result.outcome === "missing") return respond(c.html(renderNotFound(ctx), 404));
  const data = {
    rules: await loadProtectedTagRules(c.env.DB, repo),
    isOrg: await loadOwnerIsOrg(c.env.DB, repo),
    form,
    editing: null,
    saved: false,
    // The nav's conditional Actions block flag (navbar.tmpl:47).
    hasActions: (await loadRepoSettings(c.env.DB, repo.id)).hasActions,
  };
  return respond(c.html(renderTagProtectionPage({ ctx, data, error: result.message }), 200));
}

async function repoTagDetailPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const gate = await settingsGate(c, resolved);
  if (gate !== null) return gate;
  const { ctx, repo, respond } = resolved;
  const route = resolved.route;
  if (route.family !== "settings-tag-detail" || route.id === undefined) return respond(await c.notFound()); // drift guard
  const row = await loadTagRuleById(c.env.DB, repo.id, route.id);
  if (row === null) return respond(c.html(renderNotFound(ctx), 404));
  const data = {
    rules: await loadProtectedTagRules(c.env.DB, repo),
    isOrg: await loadOwnerIsOrg(c.env.DB, repo),
    form: await editFormOfTag(c.env.DB, row),
    editing: row,
    saved: false,
    // The nav's conditional Actions block flag (navbar.tmpl:47).
    hasActions: (await loadRepoSettings(c.env.DB, repo.id)).hasActions,
  };
  return respond(c.html(renderTagProtectionPage({ ctx, data, error: null }), 200));
}

async function repoTagDeleteSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const gate = await settingsGate(c, resolved);
  if (gate !== null) return gate;
  const { ctx, repo, respond } = resolved;
  if (resolved.route.family !== "settings-tags-delete") return respond(await c.notFound()); // drift guard
  if (repo.isArchived) return respond(c.html(renderNotFound(ctx), 404));
  const params = await readUrlEncodedForm(c.req.raw);
  const rawId = params.get("id") ?? "";
  if (!/^\d+$/.test(rawId)) return respond(c.html(renderNotFound(ctx), 404));
  const pair = await findRepositoryById(c.env.DB, repo.id);
  if (pair === null) return respond(c.html(renderNotFound(ctx), 404));
  const deleted = await deleteTagRuleById(c.env.DB, pair, Number.parseInt(rawId, 10));
  if (!deleted) return respond(c.html(renderNotFound(ctx), 404));
  // DeleteProtectedTagPost flashes update_settings_success — the ?saved=1
  // reduction (the module contract; the matrix's RED witness).
  return respond(new Response(null, { status: 303, headers: { location: `${repoLinkOf(repo)}/settings/tags?saved=1` } }));
}

/**
 * GET /{owner}/{repo}/settings/audit_logs (pages/settings-audit-logs.tsx —
 * the census R13 repo arm; upstream web.go:1279's
 * `m.Get("/audit_logs", repo_setting.ViewAuditLogs)` over the shared audit
 * renderer): the settings family's settingsGate posture (the whole upstream
 * group closes behind reqRepoAdmin, web.go:1283-1286 — anonymous 303s onto
 * the login round-trip, a signed-in non-admin 404-shells), then the shared
 * load → render at 200. The scope pair keys the M4 instrumentation's
 * encoding: scope_type "repository" + scope_id repo.id, the repositories.id
 * UUID the create emit carried (repos/service.ts:336-338).
 */
async function repoAuditLogsPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const gate = await settingsGate(c, resolved);
  if (gate !== null) return gate;
  const { ctx, url, repo, respond } = resolved;
  if (resolved.route.family !== "settings-audit-logs") return respond(await c.notFound()); // drift guard
  const data = await loadSettingsAuditLogs(c.env.DB, { type: "repository", id: repo.id }, url.searchParams);
  return respond(c.html(renderRepoSettingsAuditLogsPage({ ctx, data }), 200));
}

async function repoDeployKeysPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const gate = await settingsGate(c, resolved);
  if (gate !== null) return gate;
  const { respond } = resolved;
  if (resolved.route.family !== "settings-keys") return respond(await c.notFound()); // drift guard
  const data = await loadRepoDeployKeys(c.env.DB, resolved.repo);
  return respond(c.html(renderRepoDeployKeysPage({ ctx: resolved.ctx, data, error: null }), 200));
}

async function repoDeployKeysSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const gate = await settingsGate(c, resolved);
  if (gate !== null) return gate;
  const { ctx, repo, respond } = resolved;
  if (resolved.route.family !== "settings-keys") return respond(await c.notFound()); // drift guard
  const form = parseDeployKeyForm(await readUrlEncodedForm(c.req.raw));
  const outcome = await addDeployKeyFromForm(c.env.DB, repo, form);
  const data = await loadRepoDeployKeys(c.env.DB, repo);
  if (outcome.outcome === "created") {
    return respond(new Response(null, { status: 303, headers: { location: `${repoLinkOf(repo)}/settings/keys` } }));
  }
  data.form = { title: form.title, content: form.content, isWritable: form.isWritable };
  return respond(c.html(renderRepoDeployKeysPage({ ctx, data, error: { message: outcome.message, field: outcome.field } })));
}

async function repoDeployKeysDelete(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const gate = await settingsGate(c, resolved);
  if (gate !== null) return gate;
  const { repo, respond } = resolved;
  if (resolved.route.family !== "settings-keys-delete") return respond(await c.notFound()); // drift guard
  const form = parseDeployKeyDeleteForm(await readUrlEncodedForm(c.req.raw));
  // Idempotent (the module handoff: miss 204s API-side; the web twin 303s
  // on both outcomes).
  await deleteDeployKeyFromForm(c.env.DB, repo, form);
  return respond(new Response(null, { status: 303, headers: { location: `${repoLinkOf(repo)}/settings/keys` } }));
}

async function repoPublicAccessPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const gate = await settingsGate(c, resolved);
  if (gate !== null) return gate;
  const { repo, respond } = resolved;
  if (resolved.route.family !== "settings-public-access") return respond(await c.notFound()); // drift guard
  const data = await loadRepoPublicAccess(c.env.DB, repo.id);
  return respond(c.html(renderRepoPublicAccessPage({ ctx: resolved.ctx, data }), 200));
}

async function repoPublicAccessSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const gate = await settingsGate(c, resolved);
  if (gate !== null) return gate;
  const { repo, respond } = resolved;
  if (resolved.route.family !== "settings-public-access") return respond(await c.notFound()); // drift guard
  const form = parsePublicAccessForm(await readUrlEncodedForm(c.req.raw));
  await updateCodeUnitPublicAccess(c.env.DB, repo.id, form);
  return respond(new Response(null, { status: 303, headers: { location: `${repoLinkOf(repo)}/settings/public_access` } }));
}

async function repoWikiSettingsPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const gate = await settingsGate(c, resolved);
  if (gate !== null) return gate;
  const { ctx, repo, respond, url } = resolved;
  if (resolved.route.family !== "settings-wiki") return respond(await c.notFound()); // drift guard
  const data = await loadRepoWikiSettings(c.env.DB, repo);
  return respond(c.html(renderRepoWikiSettingsPage({ ctx, data, error: null, saved: url.searchParams.get("saved") === "1" }), 200));
}

async function repoWikiSettingsSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const gate = await settingsGate(c, resolved);
  if (gate !== null) return gate;
  const { repo, respond } = resolved;
  if (resolved.route.family !== "settings-wiki") return respond(await c.notFound()); // drift guard
  const form = parseRepoWikiForm(await readUrlEncodedForm(c.req.raw));
  await applyRepoWikiSettings(c.env.DB, repo, form);
  return respond(new Response(null, { status: 303, headers: { location: `${repoLinkOf(repo)}/settings/wiki?saved=1` } }));
}

// --- the census R11 arm (pages/repo-settings-lfs.tsx — upstream's
// /settings/lfs group, web.go:1249-1261; the shared settingsGate posture —
// the whole settings group closes behind reqRepoAdmin, web.go:1283-1286;
// the four surfaces are read-only pages, so no sameOriginGuard POST runs
// here) ---------------------------------------------------------------

/** GET /{owner}/{repo}/settings/lfs (LFSFiles, lfs.go:44-68): the paged
 *  meta-object listing — pure D1, renders on an unborn HEAD too (the family
 *  has no MustBeNotEmpty gate upstream). */
async function repoLfsListPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const gate = await settingsGate(c, resolved);
  if (gate !== null) return gate;
  const { url, ctx, repo, respond } = resolved;
  if (resolved.route.family !== "settings-lfs") return respond(await c.notFound()); // drift guard
  const data = await loadLfsFilesPageData(c.env, repo, parsePageNumber(url.searchParams.get("page")));
  return respond(c.html(renderRepoSettingsLfsListPage({ ctx, data }), 200));
}

/** GET /{owner}/{repo}/settings/lfs/show/{oid} (LFSFileGet, lfs.go:230-315):
 *  the detail view — an invalid oid or a meta miss 404-shells (the loader's
 *  null = lfs.go's IsValid + ErrLFSObjectNotExist arms). */
async function repoLfsDetailPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const gate = await settingsGate(c, resolved);
  if (gate !== null) return gate;
  const { ctx, repo, respond } = resolved;
  const route = resolved.route;
  if (route.family !== "settings-lfs-show" || route.name === undefined) return respond(await c.notFound()); // drift guard
  const data = await loadLfsDetailPageData(c.env, repo, route.name);
  if (data === null) return respond(c.html(renderNotFound(ctx), 404));
  return respond(c.html(renderRepoSettingsLfsDetailPage({ ctx, data }), 200));
}

/** GET /{owner}/{repo}/settings/lfs/pointers (LFSPointerFiles,
 *  lfs.go:389-495): the scan + join page — the engine's null ladder renders
 *  the found-0 empty state (never a 404); the viewer's site-admin flag keys
 *  the Associatable mid-term reduction (the read.ts header). */
async function repoLfsPointersPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const gate = await settingsGate(c, resolved);
  if (gate !== null) return gate;
  const { ctx, viewer, repo, respond } = resolved;
  if (resolved.route.family !== "settings-lfs-pointers") return respond(await c.notFound()); // drift guard
  const data = await loadLfsPointersPageData(c.env, repo, viewer.kind === "user" && viewer.isAdmin);
  return respond(c.html(renderRepoSettingsLfsPointersPage({ ctx, data }), 200));
}

/** GET /{owner}/{repo}/settings/lfs/find (LFSFileFind, lfs.go:349-386): the
 *  oid/size form's answer page — an empty oid, a junk/zero size (upstream
 *  FormInt64's miss parses 0) or a non-hex oid 404-shells (the loader's
 *  null = lfs.go:356-359's guard). */
async function repoLfsFindPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const gate = await settingsGate(c, resolved);
  if (gate !== null) return gate;
  const { url, ctx, repo, respond } = resolved;
  if (resolved.route.family !== "settings-lfs-find") return respond(await c.notFound()); // drift guard
  const size = Number.parseInt(url.searchParams.get("size") ?? "", 10);
  const data = await loadLfsFindPageData(
    c.env,
    repo,
    url.searchParams.get("oid") ?? "",
    Number.isNaN(size) ? 0 : size,
    url.searchParams.get("sha") ?? undefined,
  );
  if (data === null) return respond(c.html(renderNotFound(ctx), 404));
  return respond(c.html(renderRepoSettingsLfsFindPage({ ctx, data }), 200));
}

// ---------------------------------------------------------------------------
// The census C8 arm: the repo settings Actions secrets/variables sub-tabs
// (pages/repo-settings-actions-secrets-variables.tsx — upstream web.go:1266-
// 1278's `m.Group("/actions", ...)` with the shared secrets/variables
// builders web.go:498-506/489-496; the org twin's route shape —
// org-settings-actions.tsx — under the shared settingsGate PLUS the
// /actions group's MustEnableActions arm, sameOriginGuard-first POSTs).
// ---------------------------------------------------------------------------

/** The actions-arm gate: the shared settingsGate, then MustEnableActions'
 *  repo-unit arm (routers/web/repo/actions/actions.go:67-81 — for the repo
 *  scope it is `Permission.CanRead(TypeActions)`; the landed store's unit
 *  flag is repo_settings.has_actions, DEFAULT false). A disabled unit
 *  answers the 404 shell (upstream ctx.NotFound) — the same answer the
 *  navbar's conditional renders from (the SettingsNav hasActions prop).
 *  Returns the Response to answer, or `null` to proceed. */
async function repoActionsGate(
  c: Context<{ Bindings: Env }>,
  resolved: Extract<ResolvedUiRequest, { ok: true }>,
): Promise<Response | null> {
  const gate = await settingsGate(c, resolved);
  if (gate !== null) return gate;
  const settings = await loadRepoSettings(c.env.DB, resolved.repo.id);
  if (!settings.hasActions) return resolved.respond(c.html(renderNotFound(resolved.ctx), 404));
  return null;
}

/** GET /{owner}/{repo}/settings/actions/secrets (repo_setting.Secrets,
 *  secrets.go:76-95) through the gates. */
async function repoActionsSecretsPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const gate = await repoActionsGate(c, resolved);
  if (gate !== null) return gate;
  const { ctx, repo, respond } = resolved;
  if (resolved.route.family !== "settings-actions-secrets") return respond(await c.notFound()); // drift guard
  const data = await loadRepoActionsSecretsPageData(c.env.DB, repo.id);
  return respond(c.html(renderRepoActionsSecretsPage(ctx, data), 200));
}

/** POST /{owner}/{repo}/settings/actions/secrets (SecretsPost →
 *  PerformSecretsPost, secrets.go:98-117 / shared/secrets/secrets.go:35-56):
 *  "saved" 303s back onto the list URL (the no-session-flash reduction);
 *  "invalid" re-renders with the error line + the carried name/description
 *  only — the plaintext value never enters the DOM (the org twin's
 *  carried-form contract). */
async function repoActionsSecretsSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const gate = await repoActionsGate(c, resolved);
  if (gate !== null) return gate;
  const { ctx, repo, respond } = resolved;
  if (resolved.route.family !== "settings-actions-secrets") return respond(await c.notFound()); // drift guard
  const form = parseRepoActionsSecretForm(await readUrlEncodedForm(c.req.raw));
  const outcome = await applyRepoActionsSecretForm(c.env.DB, repo.id, form);
  if (outcome.outcome === "saved") {
    return respond(new Response(null, { status: 303, headers: { location: `${repoLinkOf(repo)}/settings/actions/secrets` } }));
  }
  const data = await loadRepoActionsSecretsPageData(c.env.DB, repo.id);
  // Carried name/description only — plaintext never enters the DOM.
  data.form = { name: form.name, data: "", description: form.description };
  return respond(c.html(renderRepoActionsSecretsPage(ctx, data, outcome.message)));
}

/** POST /{owner}/{repo}/settings/actions/secrets/delete (SecretsDelete →
 *  PerformSecretsDelete, secrets.go:119-132 / shared/secrets/secrets.go:58-
 *  71): both outcomes 303 back — a null/foreign/stale id answers "missing"
 *  and deletes nothing (the idempotent-303 reduction). */
async function repoActionsSecretsDelete(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const gate = await repoActionsGate(c, resolved);
  if (gate !== null) return gate;
  const { repo, respond } = resolved;
  if (resolved.route.family !== "settings-actions-secrets-delete") return respond(await c.notFound()); // drift guard
  const form = parseRepoActionsSecretDeleteForm(await readUrlEncodedForm(c.req.raw));
  await deleteRepoActionsSecret(c.env.DB, repo.id, form);
  return respond(new Response(null, { status: 303, headers: { location: `${repoLinkOf(repo)}/settings/actions/secrets` } }));
}

/** GET /{owner}/{repo}/settings/actions/variables (shared_actions.Variables'
 *  repo arm, variables.go:83-105) through the gates. */
async function repoActionsVariablesPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const gate = await repoActionsGate(c, resolved);
  if (gate !== null) return gate;
  const { ctx, repo, respond } = resolved;
  if (resolved.route.family !== "settings-actions-variables") return respond(await c.notFound()); // drift guard
  const data = await loadRepoActionsVariablesPageData(c.env.DB, repo.id);
  return respond(c.html(renderRepoActionsVariablesPage(ctx, data), 200));
}

/** POST /{owner}/{repo}/settings/actions/variables/new (VariableCreate,
 *  variables.go:107-129): "saved" 303s back; "invalid" re-renders with ALL
 *  THREE fields carried (the value rides along, unlike secrets); the
 *  "missing" arm cannot arise on create — a non-ApiError (the UNIQUE
 *  duplicate-name db error) propagates to the generic error handler, the
 *  twins' shape. */
async function repoActionsVariablesNew(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const gate = await repoActionsGate(c, resolved);
  if (gate !== null) return gate;
  const { ctx, repo, respond } = resolved;
  if (resolved.route.family !== "settings-actions-variables-new") return respond(await c.notFound()); // drift guard
  const form = parseRepoActionsVariableForm(await readUrlEncodedForm(c.req.raw));
  const outcome = await applyRepoActionsVariableCreate(c.env.DB, repo.id, form);
  if (outcome.outcome === "saved") {
    return respond(new Response(null, { status: 303, headers: { location: `${repoLinkOf(repo)}/settings/actions/variables` } }));
  }
  const data = await loadRepoActionsVariablesPageData(c.env.DB, repo.id);
  if (outcome.outcome === "invalid") {
    data.form = { name: form.name, data: form.data, description: form.description };
    return respond(c.html(renderRepoActionsVariablesPage(ctx, data, outcome.message)));
  }
  return respond(c.html(renderNotFound(ctx), 404));
}

/** POST /{owner}/{repo}/settings/actions/variables/{id}/edit
 *  (VariableUpdate, variables.go:131-161): "saved" 303s back; "missing" is
 *  upstream's findActionsVariable arm — a genuine ctx.NotFound(nil)
 *  (variables.go:172-175) — the 404 shell; "invalid" re-renders with all
 *  three fields carried. */
async function repoActionsVariablesEdit(c: Context<{ Bindings: Env }>, variableId: number): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const gate = await repoActionsGate(c, resolved);
  if (gate !== null) return gate;
  const { ctx, repo, respond } = resolved;
  if (resolved.route.family !== "settings-actions-variables-edit") return respond(await c.notFound()); // drift guard
  const form = parseRepoActionsVariableForm(await readUrlEncodedForm(c.req.raw));
  const outcome = await applyRepoActionsVariableUpdate(c.env.DB, repo.id, variableId, form);
  if (outcome.outcome === "saved") {
    return respond(new Response(null, { status: 303, headers: { location: `${repoLinkOf(repo)}/settings/actions/variables` } }));
  }
  if (outcome.outcome === "missing") {
    // Upstream's findActionsVariable miss → ctx.NotFound(nil) — a genuine
    // 404 (the org twin's fidelity call).
    return respond(c.html(renderNotFound(ctx), 404));
  }
  const data = await loadRepoActionsVariablesPageData(c.env.DB, repo.id);
  data.form = { name: form.name, data: form.data, description: form.description };
  return respond(c.html(renderRepoActionsVariablesPage(ctx, data, outcome.message)));
}

/** POST /{owner}/{repo}/settings/actions/variables/{id}/delete
 *  (VariableDelete, variables.go:179-200): "deleted" 303s back; "missing"
 *  is the same NotFound arm (variables.go:186-191). */
async function repoActionsVariablesDelete(c: Context<{ Bindings: Env }>, variableId: number): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const gate = await repoActionsGate(c, resolved);
  if (gate !== null) return gate;
  const { ctx, repo, respond } = resolved;
  if (resolved.route.family !== "settings-actions-variables-delete") return respond(await c.notFound()); // drift guard
  const outcome = await deleteRepoActionsVariable(c.env.DB, repo.id, variableId);
  if (outcome === "missing") return respond(c.html(renderNotFound(ctx), 404));
  return respond(new Response(null, { status: 303, headers: { location: `${repoLinkOf(repo)}/settings/actions/variables` } }));
}

// ---------------------------------------------------------------------------
// The census C1 arm: the repo Actions tab's RUNS LIST (pages/
// repo-actions-runs.tsx — upstream web.go:1606-1608's /actions group with
// actions.List). The READ group's gate ladder mirrors the group middleware
// exactly: resolveUiRequest IS optSignIn + RepoAssignment (a public repo
// renders for anonymous — NO settingsGate here), then repo.MustBeNotEmpty
// (actions.go's GetBranchCommit miss → NotFoundPrompt 404; the empty-repo
// shell's own arm), then MustEnableActions' repo-unit arm — the C8 gate's
// has_actions polarity (a disabled unit answers the 404 shell and the
// navbar's conditional renders from the same flag). The `?run_ids=` query
// presence is the fragment discriminator (actions.go:632 Form.Has): the
// partial-refresh arm renders the runs_list fragment ALONE — the morph
// root the bundle's initActionRunsList timer polls.
// ---------------------------------------------------------------------------

/** GET /{owner}/{repo}/actions (actions.List) — the full page, or the
 *  `?run_ids=` fragment. */
async function repoActionsRunsPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const { url, ctx, viewer, repo, respond } = resolved;
  if (resolved.route.family !== "repo-actions-runs") return respond(await c.notFound()); // drift guard
  // repo.MustBeNotEmpty (web.go:1608's group middleware) — an empty repo
  // has no default branch to list workflows from; upstream 404s the group
  // (actions.go:90-98's GetBranchCommit miss arm).
  if (repo.isEmpty) return respond(c.html(renderNotFound(ctx), 404));
  // MustEnableActions' repo-unit arm (actions.go:67-81 → the landed
  // repo_settings.has_actions) — the C8 gate's polarity verbatim.
  const settings = await loadRepoSettings(c.env.DB, repo.id);
  if (!settings.hasActions) return respond(c.html(renderNotFound(ctx), 404));
  const data = await loadRepoActionsRunsData({
    d1: c.env.DB,
    engine: engineClient(c.env, `${repo.ownerNamespace}/${repo.slug}`),
    repo,
    query: parseActionRunQuery(url.searchParams),
    requestUri: url.pathname + url.search,
    canWriteActions: viewer.kind === "user" && (await canWriteRepo(c.env, repo, viewer)),
    nowSeconds: Math.floor(routeNow().getTime() / 1000),
  });
  if (resolved.url.searchParams.has("run_ids")) {
    return respond(c.html(renderRepoActionsRunsFragment(data, `/${repo.ownerNamespace}/${repo.slug}`), 200));
  }
  return respond(c.html(renderRepoActionsRunsPage(ctx, data), 200));
}

// ---------------------------------------------------------------------------
// The census C2 arm: the run-viewer subtree (pages/repo-actions-view.tsx —
// web.go:1601-1605's cancel POST + the three GET+POST view pairs). The gate
// ladder is the C1 read group's verbatim (the run viewer needs NO sign-in on
// a readable repo — upstream's optSignIn + reqRepoActionsReader), the write
// arms add RequireUnitWriter's NotFound (the cancel POST 404-shells an
// anonymous viewer — a fetch arm, never the login 303). The GET is the SSR
// mount shell (view.tmpl's two data attributes + the locale set); the POST
// is the ViewResponse JSON twin (the official bundle's Vue app polls it).
// ---------------------------------------------------------------------------

/** The view subtree's shared read gate: the C1 handler's MustBeNotEmpty +
 *  MustEnableActions arms verbatim. Returns the Response to answer, or null
 *  to proceed. */
async function actionsRunViewGate(
  c: Context<{ Bindings: Env }>,
  resolved: Extract<ResolvedUiRequest, { ok: true }>,
): Promise<Response | null> {
  const { ctx, repo, respond } = resolved;
  if (repo.isEmpty) return respond(c.html(renderNotFound(ctx), 404));
  const settings = await loadRepoSettings(c.env.DB, repo.id);
  if (!settings.hasActions) return respond(c.html(renderNotFound(ctx), 404));
  return null;
}

/** The resolved run for one view request, answering the 404/redirect arms
 *  upstream's resolution returns. */
async function resolveActionsRunOrAnswer(
  c: Context<{ Bindings: Env }>,
  resolved: Extract<ResolvedUiRequest, { ok: true }>,
  runRaw: string,
  jobRaw: string,
  idFirst: boolean,
): Promise<Response | { answer: "run"; run: RunRow }> {
  const { url, ctx, repo, respond } = resolved;
  const repoLink = `/${repo.ownerNamespace}/${repo.slug}`;
  const outcome = idFirst
    ? await (async () => {
        const run = await resolveRunByPath(c.env.DB, repo.id, runRaw);
        return run === null ? { outcome: "not-found" as const } : { outcome: "run" as const, run };
      })()
    : await resolveRunForView(
        c.env.DB,
        repo.id,
        runRaw,
        jobRaw,
        url.searchParams.get("by_id") === "1",
        url.searchParams.get("by_index") === "1",
        repoLink,
      );
  if (outcome.outcome === "not-found") return respond(c.html(renderNotFound(ctx), 404));
  if (outcome.outcome === "redirect") {
    // ctx.Redirect(..., http.StatusFound) — the legacy index-URL
    // canonicalization (view.go:123-128/225-233), a 302 Found.
    return respond(new Response(null, { status: 302, headers: { location: outcome.location } }));
  }
  return { answer: "run", run: outcome.run };
}

/** GET /{owner}/{repo}/actions/runs/{run}[/attempts/{n}][/jobs/{n}]
 *  (actions.View) — the SSR mount shell. */
async function actionsRunViewPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const { ctx, repo, respond } = resolved;
  if (resolved.route.family !== "actions-run-view") return respond(await c.notFound()); // drift guard
  const gate = await actionsRunViewGate(c, resolved);
  if (gate !== null) return gate;
  const route = resolved.route;
  const run = await resolveActionsRunOrAnswer(c, resolved, route.run, route.job ?? "", false);
  if (!("answer" in run)) return run;
  const attemptNum = route.attempt === undefined ? 0 : parsePathParamInt64(route.attempt);
  const jobId = route.job === undefined ? 0 : parsePathParamInt64(route.job);
  const runLink = `/${repo.ownerNamespace}/${repo.slug}/actions/runs/${run.run.id}`;
  // ActionsViewURL (view.go:311-324): the endpoint the Vue app POSTs its
  // state polls to — attempt-scoped, job-scoped, or the bare run link.
  const actionsViewUrl =
    attemptNum > 0 ? `${runLink}/attempts/${attemptNum}` : jobId > 0 ? `${runLink}/jobs/${jobId}` : runLink;
  const data = await loadRepoActionsViewPageData(c.env.DB, run.run, jobId);
  data.actionsViewUrl = actionsViewUrl;
  return respond(c.html(renderRepoActionsViewPage(ctx, data), 200));
}

/** POST /{owner}/{repo}/actions/runs/{run}[/attempts/{n}][/jobs/{n}]
 *  (actions.ViewPost) — the ViewResponse JSON the official bundle's Vue app
 *  renders from (and polls while `!state.run.done`). The sameOriginGuard
 *  rides first (the census open question 5's posture — a same-origin fetch
 *  sends Origin; cross-origin 403s before any read). */
async function actionsRunViewJson(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const { ctx, viewer, repo, respond } = resolved;
  if (resolved.route.family !== "actions-run-view") return respond(await c.notFound()); // drift guard
  const gate = await actionsRunViewGate(c, resolved);
  if (gate !== null) return gate;
  const route = resolved.route;
  // ViewPost resolves through getCurrentRunJobsByPathParam — the ID-based
  // lookup WITHOUT the GET's index disambiguation (the module header's
  // GET/POST asymmetry note).
  const run = await resolveActionsRunOrAnswer(c, resolved, route.run, route.job ?? "", true);
  if (!("answer" in run)) return run;
  const { attempt, jobs } = await resolveRunAttemptAndJobs(c.env.DB, run.run, route.attempt ?? "", route.job ?? "");
  const request = await readViewRequest(c.req.raw);
  const built = await buildViewResponse(c.env.DB, run.run, { attempt, jobs }, {
    env: c.env,
    repo,
    canWriteActions: viewer.kind === "user" && (await canWriteRepo(c.env, repo, viewer)),
    isSigned: viewer.kind === "user",
    logCursors: request.logCursors,
    attemptRaw: route.attempt ?? "",
    jobRaw: route.job ?? "",
  });
  if (built.outcome === "not-found") return respond(c.html(renderNotFound(ctx), 404));
  // ctx.JSON's content type (services/context/base.go:115-117).
  return respond(
    new Response(JSON.stringify(built.response), {
      status: 200,
      headers: { "content-type": "application/json;charset=utf-8" },
    }),
  );
}

/** GET /{owner}/{repo}/actions/artifacts/{id}/preview[/...] (actions.
 *  ArtifactsView — the census C4 SSR file browser, view_artifact.go:341-390).
 *  The C2 read ladder (MustBeNotEmpty + the actions unit gate); the disable
 *  arm answers the 404 shell, upstream's ServerError arms (a missing or
 *  unconfirmed artifact, a missing run) answer the 500 chrome — a missing
 *  artifact IS a ServerError on this route, not a 404. */
async function actionsArtifactPreviewPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const { ctx, repo, respond } = resolved;
  if (resolved.route.family !== "actions-artifact-preview") return respond(await c.notFound()); // drift guard
  const gate = await actionsRunViewGate(c, resolved);
  if (gate !== null) return gate;
  const outcome = await loadArtifactPreviewPageData(c.env, repo, resolved.route.artifactId, resolved.route.previewPath);
  if (outcome.outcome === "not-found") return respond(c.html(renderNotFound(ctx), 404));
  if (outcome.outcome === "error") return renderServerErrorShellResponse(c.env, c.req.raw);
  return respond(c.html(renderArtifactPreviewPage(ctx, outcome.data), 200));
}

/** GET /-/actions/artifacts/{id}/{expires}/{signature}[/...] — the C4 SIGNED
 *  raw serving (view_artifact.go:392-484): the HMAC is the auth, so the
 *  route runs viewer-less; every gate/family/entry miss is an opaque 404,
 *  the size cap 413s, the sniffer gate 415s, and document navigations 302
 *  to the repo-scoped preview page. The sandbox helper script rides the
 *  manifest's web_src/js/external-render-helper.ts entry — an absent entry
 *  or unbuilt assets degrade to no injection (the null arm). */
async function actionsArtifactPreviewRaw(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiSession(c);
  if (!resolved.ok) return resolved.response;
  const route = resolved.route;
  if (route.family !== "actions-artifact-preview-raw") return resolved.respond(await c.notFound()); // drift guard
  let helperScriptSrc: string | null;
  try {
    const manifest = await loadManifest(assetsBinding(c.env), resolved.url.origin);
    helperScriptSrc = assetURI(manifest, "web_src/js/external-render-helper.ts");
  } catch (error) {
    if (!(error instanceof AssetBuildError)) throw error;
    helperScriptSrc = null; // unbuilt assets / absent entry — the null arm skips injection
  }
  return resolved.respond(
    await serveArtifactPreviewRaw(c.env, {
      artifactId: route.artifactId,
      expires: route.expires,
      signature: route.signature,
      tail: route.previewPath,
      secFetchDest: c.req.header("sec-fetch-dest") ?? null,
      helperScriptSrc,
    }),
  );
}

/** GET /{owner}/{repo}/actions/runs/{run}/artifacts/{artifact_name}
 *  (actions.ArtifactsDownloadView — the census C4 remainder, the C2 read
 *  ladder): the v4 single-artifact stream with the minimal single-range
 *  arm, or the legacy family's streaming zip compose. The body is a LIVE
 *  stream — respond() wraps it unchanged, never buffered. */
async function actionsRunArtifactDownload(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const { ctx, repo, respond } = resolved;
  if (resolved.route.family !== "actions-run-artifact") return respond(await c.notFound()); // drift guard
  const gate = await actionsRunViewGate(c, resolved);
  if (gate !== null) return gate;
  const run = await resolveRunByPath(c.env.DB, repo.id, resolved.route.run);
  if (run === null) return respond(c.html(renderNotFound(ctx), 404)); // getCurrentRunByPathParam's NotFound
  const outcome = await buildRunArtifactDownload(
    c.env,
    run,
    resolved.route.artifactName,
    resolved.url.searchParams.get("attempt") ?? "",
    c.req.header("range") ?? null,
  );
  if (outcome.outcome === "not-found") return respond(c.html(renderNotFound(ctx), 404));
  if (outcome.outcome === "error") return renderServerErrorShellResponse(c.env, c.req.raw);
  return respond(outcome.response);
}

/** DELETE /{owner}/{repo}/actions/runs/{run}/artifacts/{artifact_name}
 *  (actions.ArtifactsDeleteView — web.go:1596's reqRepoActionsWriter): the
 *  pending-deletion MARK only (the retention sweep owns deletion), answered
 *  with ctx.JSON's {} — not Cancel's JSONOK. */
async function actionsRunArtifactDelete(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const { ctx, viewer, repo, respond } = resolved;
  if (resolved.route.family !== "actions-run-artifact") return respond(await c.notFound()); // drift guard
  const gate = await actionsRunViewGate(c, resolved);
  if (gate !== null) return gate;
  if (viewer.kind !== "user" || !(await canWriteRepo(c.env, repo, viewer))) {
    return respond(c.html(renderNotFound(ctx), 404)); // RequireUnitWriter's NotFound
  }
  const run = await resolveRunByPath(c.env.DB, repo.id, resolved.route.run);
  if (run === null) return respond(c.html(renderNotFound(ctx), 404));
  const outcome = await deleteRunArtifact(c.env.DB, run, resolved.route.artifactName, resolved.url.searchParams.get("attempt") ?? "");
  if (outcome.outcome === "error") return renderServerErrorShellResponse(c.env, c.req.raw);
  return respond(outcome.response);
}

/** GET /{owner}/{repo}/actions/runs/{run}/jobs/{job}/logs (the F-row tail,
 *  pages/repo-actions-logs.ts — web.go:1589): the raw job-log download over
 *  M1b's chunk store/R2 seal, bytes re-issued without the line parse (a
 *  download serves bytes even when a line is malformed). C2 read ladder. */
async function actionsRunJobLogsRoute(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const { ctx, repo, respond } = resolved;
  if (resolved.route.family !== "actions-run-job-logs") return respond(await c.notFound()); // drift guard
  const gate = await actionsRunViewGate(c, resolved);
  if (gate !== null) return gate;
  const route = resolved.route;
  const outcome = await loadActionsRunJobLogs(c.env.DB, c.env, repo.id, route.run, route.job ?? "");
  if (outcome.outcome === "not-found") return respond(c.html(renderNotFound(ctx), 404));
  if (outcome.outcome === "throw") throw new Error(outcome.reason); // upstream's ctx.ServerError arm
  return respond(actionsJobLogsResponse(outcome.bytes, outcome.filename));
}

/** GET /{owner}/{repo}/actions/runs/{run}/workflow (the F-row tail, pages/
 *  repo-actions-workflow.ts — web.go:1591): upstream renders NO page here —
 *  a 303 onto the workflow file's blob/src view via the engine read family,
 *  tolerating both workflow-id spellings the store carries. */
async function actionsRunWorkflowRoute(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const { ctx, repo, respond } = resolved;
  if (resolved.route.family !== "actions-run-workflow") return respond(await c.notFound()); // drift guard
  const gate = await actionsRunViewGate(c, resolved);
  if (gate !== null) return gate;
  const route = resolved.route;
  const outcome = await resolveActionsRunWorkflowFile(
    c.env.DB,
    engineReads(c.env, repo),
    repo,
    route.run ?? "",
    `/${repo.ownerNamespace}/${repo.slug}`,
  );
  if (outcome.outcome === "not-found") return respond(c.html(renderNotFound(ctx), 404));
  if (outcome.outcome === "throw") throw new Error(outcome.reason); // upstream's ctx.ServerError arm
  return respond(new Response(null, { status: 303, headers: { location: outcome.location } }));
}

/** GET /{owner}/{repo}/actions/workflows/{workflow_name}/badge.svg (the
 *  F-row tail, pages/repo-actions-badge.ts — web.go:1606): the shields-style
 *  status SVG over the run store — C1 read ladder, anonymous reads pass. */
async function repoActionsWorkflowBadgeRoute(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const { ctx, url, repo, respond } = resolved;
  if (resolved.route.family !== "repo-actions-workflow-badge") return respond(await c.notFound()); // drift guard
  if (repo.isEmpty) return respond(c.html(renderNotFound(ctx), 404));
  const settings = await loadRepoSettings(c.env.DB, repo.id);
  if (!settings.hasActions) return respond(c.html(renderNotFound(ctx), 404));
  const badge = await resolveWorkflowBadge(c.env.DB, repo, {
    workflowName: resolved.route.workflowName,
    branch: url.searchParams.get("branch") ?? undefined,
    event: url.searchParams.get("event") ?? undefined,
    style: url.searchParams.get("style") ?? undefined,
  });
  return respond(
    new Response(renderWorkflowBadgeSvg(badge), {
      status: 200,
      headers: { "content-type": "image/svg+xml" },
    }),
  );
}

/** GET /{owner}/{repo}/actions/workflow-dispatch-inputs (the F-row tail,
 *  pages/repo-actions-dispatch-inputs.tsx — web.go:1572): the dispatch
 *  modal's inputs HTML fragment — read ladder PLUS the writer gate (upstream
 *  mounts it under reqRepoActionsWriter), GET-only so no sameOriginGuard. */
async function repoActionsDispatchInputsRoute(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const { ctx, url, viewer, repo, respond } = resolved;
  if (resolved.route.family !== "repo-actions-dispatch-inputs") return respond(await c.notFound()); // drift guard
  if (repo.isEmpty) return respond(c.html(renderNotFound(ctx), 404));
  const settings = await loadRepoSettings(c.env.DB, repo.id);
  if (!settings.hasActions) return respond(c.html(renderNotFound(ctx), 404));
  if (viewer.kind !== "user" || !(await canWriteRepo(c.env, repo, viewer))) {
    return respond(c.html(renderNotFound(ctx), 404)); // reqRepoActionsWriter's NotFound
  }
  const formInt64 = (raw: string | null): number => (raw !== null && /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : 0);
  const outcome = await loadWorkflowDispatchInputsFragment({
    reads: engineClient(c.env, `${repo.ownerNamespace}/${repo.slug}`),
    repo,
    ref: url.searchParams.get("ref") ?? "",
    workflow: url.searchParams.get("workflow") ?? "",
    scopedWorkflowSourceRepoId: formInt64(url.searchParams.get("scoped_workflow_source_repo_id")),
  });
  if (outcome.status === "not-found") return respond(c.html(renderNotFound(ctx), 404));
  if (outcome.status === "throw") throw new Error(outcome.reason); // upstream's ctx.ServerError arm
  return respond(c.html(outcome.html, 200));
}

/** POST /{owner}/{repo}/actions/runs/{run}/cancel (actions.Cancel — the
 *  census C5-adjacent arm): the writer gate (RequireUnitWriter's NotFound —
 *  anonymous 404-shells, never the login 303), the latest-attempt check
 *  (view.go:944-951), then the CancelRun v1 reduction, answering
 *  ctx.JSONOK's `{"ok":true}` dummy the frontend seldom reads. */
async function actionsRunCancel(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const { ctx, viewer, repo, respond } = resolved;
  if (resolved.route.family !== "actions-run-cancel") return respond(await c.notFound()); // drift guard
  const gate = await actionsRunViewGate(c, resolved);
  if (gate !== null) return gate;
  if (viewer.kind !== "user" || !(await canWriteRepo(c.env, repo, viewer))) {
    return respond(c.html(renderNotFound(ctx), 404)); // RequireUnitWriter's NotFound
  }
  const route = resolved.route;
  const run = await resolveActionsRunOrAnswer(c, resolved, route.run, "", true);
  if (!("answer" in run)) return run;
  const { attempt, jobs } = await resolveRunAttemptAndJobs(c.env.DB, run.run, "", "");
  // checkLatestAttempt (view.go:944-951): only the run's latest attempt
  // cancels — a historical attempt URL answers the 404 shell.
  if (attempt !== null && run.run.latestAttemptId !== attempt.id) {
    return respond(c.html(renderNotFound(ctx), 404));
  }
  await cancelActionRun(c.env.DB, run.run, jobs);
  return respond(
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json;charset=utf-8" },
    }),
  );
}

// ---------------------------------------------------------------------------
// The census C6 arm: the Actions JOB QUEUE pages (pages/repo-actions-queue.tsx
// — the repo tab arm web.go:1570 + the admin instance arm web.go:904 over
// the ONE shared fragment; `?refresh=1` answers the fragment ONLY — the
// morph contract the bundle's initActionJobQueueList timer polls). The repo
// arm's gate ladder is the C1 runs-list arm's (optSignIn + RepoAssignment
// via resolveUiRequest, then repo.MustBeNotEmpty, then MustEnableActions'
// repo-unit arm — the C8 gate's polarity; NO settingsGate: the read page
// renders for any viewer who can read the repo). The admin arm rides the
// shared adminPagePrologue (SignInRequired+AdminRequired, web.go:779).
// ---------------------------------------------------------------------------

/** GET /{owner}/{repo}/actions/job_queue (repo/actions.JobQueue) — the full
 * page, or the `?refresh=1` fragment. */
async function repoActionsJobQueuePage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const { url, ctx, repo, respond } = resolved;
  if (resolved.route.family !== "repo-actions-job-queue") return respond(await c.notFound()); // drift guard
  // repo.MustBeNotEmpty (web.go:1571's group middleware) — the C1 arm's
  // empty-repo posture.
  if (repo.isEmpty) return respond(c.html(renderNotFound(ctx), 404));
  // MustEnableActions' repo-unit arm (job_queue.go:83's RenderJobQueue sits
  // behind the group middleware; the landed repo_settings.has_actions).
  const settings = await loadRepoSettings(c.env.DB, repo.id);
  if (!settings.hasActions) return respond(c.html(renderNotFound(ctx), 404));
  const data = await loadJobQueuePageData(
    c.env.DB,
    { kind: "repo", repoId: repo.id, repoLink: `/${repo.ownerNamespace}/${repo.slug}` },
    url.searchParams,
  );
  if (url.searchParams.has("refresh")) {
    return respond(c.html(renderJobQueueFragment(data), 200));
  }
  return respond(c.html(renderRepoActionsJobQueuePage(ctx, data), 200));
}

/** GET /-/admin/actions/job_queue (shared_actions.JobQueue's admin arm,
 * job_queue.go:21-31 — RenderJobQueue(ctx, 0, "admin/actions")). */
async function adminActionsJobQueuePage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const p = await adminPagePrologue(c);
  if (!p.ok) return p.response;
  const search = new URL(c.req.raw.url).searchParams;
  const data = await loadJobQueuePageData(c.env.DB, { kind: "admin" }, search);
  if (search.has("refresh")) {
    return p.respond(c.html(renderJobQueueFragment(data), 200));
  }
  return p.respond(c.html(renderAdminActionsJobQueuePage(p.ctx, data), 200));
}

/** GET /-/admin/actions (the bare group literal — misc.LocationRedirect's
 *  303 onto ./actions/runners, misc.go:76-80's EXACT relative bytes; the
 *  prologue gates the redirect because upstream mounts it inside adminReq). */
async function adminActionsGroupRedirect(c: Context<{ Bindings: Env }>): Promise<Response> {
  const p = await adminPagePrologue(c);
  if (!p.ok) return p.response;
  return p.respond(new Response(null, { status: 303, headers: { location: "./actions/runners" } }));
}

/** The admin actions RUNNERS family's handlers (pages/admin-actions-runners.
 *  tsx — web.go:898-901 + the bulk POST; writes sameOriginGuard-first). */
async function adminActionsRunnersPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const p = await adminPagePrologue(c);
  if (!p.ok) return p.response;
  const data = await loadAdminActionsRunnersPageData(c.env.DB, new URL(c.req.raw.url).searchParams);
  return p.respond(c.html(renderAdminActionsRunnersPage(p.ctx, data), 200));
}

async function adminActionsRunnersTokenReset(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const p = await adminPagePrologue(c);
  if (!p.ok) return p.response;
  await resetAdminActionsRunnerToken(c.env.DB);
  return p.respond(new Response(null, { status: 303, headers: { location: "/-/admin/actions/runners" } }));
}

async function adminActionsRunnerEditPage(c: Context<{ Bindings: Env }>, runnerId: number): Promise<Response> {
  const p = await adminPagePrologue(c);
  if (!p.ok) return p.response;
  const data = await loadAdminActionsRunnerEditPageData(c.env.DB, runnerId, new URL(c.req.raw.url).searchParams);
  if (data === null) return p.respond(c.html(renderNotFound(p.ctx), 404));
  return p.respond(c.html(renderAdminActionsRunnerEditPage(p.ctx, data), 200));
}

async function adminActionsRunnerEditSubmit(c: Context<{ Bindings: Env }>, runnerId: number): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const p = await adminPagePrologue(c);
  if (!p.ok) return p.response;
  const form = parseAdminActionsRunnerDescriptionForm(await readUrlEncodedForm(c.req.raw));
  const outcome = await updateAdminActionsRunnerDescription(c.env.DB, runnerId, form.description);
  if (outcome === "missing") return p.respond(c.html(renderNotFound(p.ctx), 404));
  return p.respond(new Response(null, { status: 303, headers: { location: "/-/admin/actions/runners" } }));
}

async function adminActionsRunnerUpdate(c: Context<{ Bindings: Env }>, runnerId: number): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const p = await adminPagePrologue(c);
  if (!p.ok) return p.response;
  const form = parseAdminActionsRunnerDisabledForm(await readUrlEncodedForm(c.req.raw));
  if (form.disabled === null) {
    return p.respond(
      new Response("missing 'disabled' parameter\n", {
        status: 400,
        headers: { "content-type": "text/plain;charset=utf-8", "x-content-type-options": "nosniff" },
      }),
    );
  }
  const outcome = await setAdminActionsRunnerDisabled(c.env.DB, runnerId, form.disabled);
  if (outcome === "missing") return p.respond(c.html(renderNotFound(p.ctx), 404));
  return p.respond(new Response(null, { status: 303, headers: { location: `/-/admin/actions/runners/${runnerId}` } }));
}

async function adminActionsRunnerDelete(c: Context<{ Bindings: Env }>, runnerId: number): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const p = await adminPagePrologue(c);
  if (!p.ok) return p.response;
  const outcome = await deleteAdminActionsRunner(c.env.DB, runnerId);
  if (outcome === "missing") return p.respond(c.html(renderNotFound(p.ctx), 404));
  return p.respond(new Response(null, { status: 303, headers: { location: "/-/admin/actions/runners" } }));
}

async function adminActionsRunnersBulk(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const p = await adminPagePrologue(c);
  if (!p.ok) return p.response;
  const form = parseAdminActionsRunnerBulkForm(await readUrlEncodedForm(c.req.raw));
  const outcome = await bulkAdminActionsRunners(c.env.DB, form);
  if (outcome === "invalid-ids") {
    return p.respond(
      new Response("missing runner IDs\n", {
        status: 400,
        headers: { "content-type": "text/plain;charset=utf-8", "x-content-type-options": "nosniff" },
      }),
    );
  }
  if (outcome === "invalid-action") {
    return p.respond(
      new Response("invalid action\n", {
        status: 400,
        headers: { "content-type": "text/plain;charset=utf-8", "x-content-type-options": "nosniff" },
      }),
    );
  }
  return p.respond(new Response(null, { status: 303, headers: { location: "/-/admin/actions/runners" } }));
}

/** The admin actions VARIABLES family's handlers (pages/admin-actions-
 *  variables.tsx — web.go:902). */
async function adminActionsVariablesPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const p = await adminPagePrologue(c);
  if (!p.ok) return p.response;
  const data = await loadAdminActionsVariablesPageData(c.env.DB);
  return p.respond(c.html(renderAdminActionsVariablesPage(p.ctx, data), 200));
}

async function adminActionsVariableCreate(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const p = await adminPagePrologue(c);
  if (!p.ok) return p.response;
  const form = parseAdminActionsVariableForm(await readUrlEncodedForm(c.req.raw));
  const outcome = await applyAdminActionsVariableCreate(c.env.DB, form);
  if (outcome.outcome === "saved") {
    return p.respond(new Response(null, { status: 303, headers: { location: "/-/admin/actions/variables" } }));
  }
  // The shared union's arm — unreachable at create (no path id), answered
  // defensively rather than de-narrowed.
  if (outcome.outcome === "missing") return p.respond(c.html(renderNotFound(p.ctx), 404));
  const data = await loadAdminActionsVariablesPageData(c.env.DB);
  return p.respond(c.html(renderAdminActionsVariablesPage(p.ctx, data, outcome.message), 200));
}

async function adminActionsVariableEdit(c: Context<{ Bindings: Env }>, variableId: number): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const p = await adminPagePrologue(c);
  if (!p.ok) return p.response;
  const form = parseAdminActionsVariableForm(await readUrlEncodedForm(c.req.raw));
  const outcome = await applyAdminActionsVariableUpdate(c.env.DB, variableId, form);
  if (outcome.outcome === "saved") {
    return p.respond(new Response(null, { status: 303, headers: { location: "/-/admin/actions/variables" } }));
  }
  if (outcome.outcome === "missing") return p.respond(c.html(renderNotFound(p.ctx), 404));
  const data = await loadAdminActionsVariablesPageData(c.env.DB);
  return p.respond(c.html(renderAdminActionsVariablesPage(p.ctx, data, outcome.message), 200));
}

async function adminActionsVariableDelete(c: Context<{ Bindings: Env }>, variableId: number): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const p = await adminPagePrologue(c);
  if (!p.ok) return p.response;
  const outcome = await deleteAdminActionsVariable(c.env.DB, variableId);
  if (outcome === "missing") return p.respond(c.html(renderNotFound(p.ctx), 404));
  return p.respond(new Response(null, { status: 303, headers: { location: "/-/admin/actions/variables" } }));
}

// ---------------------------------------------------------------------------
// The census C7 arm: the repo settings Actions RUNNERS sub-tab (pages/
// repo-settings-actions-runners.tsx — upstream web.go:506-513's
// addSettingsRunnersRoutes at the REPO scope, behind the C8 gate's exact
// posture: the shared settingsGate (reqRepoAdmin) PLUS MustEnableActions'
// repo-unit arm, sameOriginGuard-first POSTs).
// ---------------------------------------------------------------------------

/** GET /{owner}/{repo}/settings/actions/runners (shared_actions.Runners'
 * repo arm, runners.go:102-155) through the gates. */
async function repoActionsRunnersPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const gate = await repoActionsGate(c, resolved);
  if (gate !== null) return gate;
  const { ctx, repo, respond } = resolved;
  if (resolved.route.family !== "settings-actions-runners") return respond(await c.notFound()); // drift guard
  const data = await loadRepoActionsRunnersPageData(c.env.DB, repo, new URL(c.req.raw.url).searchParams);
  return respond(c.html(renderRepoActionsRunnersPage(ctx, data), 200));
}

/** POST /{owner}/{repo}/settings/actions/runners/reset_registration_token
 * (ResetRunnerRegistrationToken, runners.go:275-290): NewRunnerToken at the
 * repo scope, then the plain 303 back onto the list URL (upstream's
 * JSONRedirect — the no-session-flash 303 reduction, the secrets arms'
 * convention). */
async function repoActionsRunnersTokenReset(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const gate = await repoActionsGate(c, resolved);
  if (gate !== null) return gate;
  const { repo, respond } = resolved;
  if (resolved.route.family !== "settings-actions-runners-token-reset") return respond(await c.notFound()); // drift guard
  await resetRepoActionsRunnerToken(c.env.DB, repo.id);
  return respond(new Response(null, { status: 303, headers: { location: `${repoLinkOf(repo)}/settings/actions/runners` } }));
}

/** GET /{owner}/{repo}/settings/actions/runners/{id} (RunnersEdit,
 * runners.go:158-210): the scope-guarded runner plus its recent tasks; a
 * foreign/stale/junk id answers the 404 shell (upstream's findActionsRunner
 * + EditableInContext NotFound arms — both fold into the module's scope
 * predicate). */
async function repoActionsRunnerEditPage(c: Context<{ Bindings: Env }>, runnerId: number): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const gate = await repoActionsGate(c, resolved);
  if (gate !== null) return gate;
  const { ctx, repo, respond } = resolved;
  if (resolved.route.family !== "settings-actions-runners-edit") return respond(await c.notFound()); // drift guard
  const data = await loadRepoActionsRunnerEditPageData(c.env.DB, repo, runnerId, new URL(c.req.raw.url).searchParams);
  if (data === null) return respond(c.html(renderNotFound(ctx), 404));
  return respond(c.html(renderRepoActionsRunnerEditPage(ctx, data), 200));
}

/** POST /{owner}/{repo}/settings/actions/runners/{id} (RunnersEditPost,
 * runners.go:212-246): the description overwrite; "updated" 303s back onto
 * the LIST URL (upstream's Redirect(redirectTo) with the flash line not
 * rendered — the no-session-flash reduction); "missing" is the scope
 * guard's 404 shell. */
async function repoActionsRunnerEditSubmit(c: Context<{ Bindings: Env }>, runnerId: number): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const gate = await repoActionsGate(c, resolved);
  if (gate !== null) return gate;
  const { ctx, repo, respond } = resolved;
  if (resolved.route.family !== "settings-actions-runners-edit") return respond(await c.notFound()); // drift guard
  const form = parseRepoActionsRunnerDescriptionForm(await readUrlEncodedForm(c.req.raw));
  const outcome = await updateRepoActionsRunnerDescription(c.env.DB, repo.id, runnerId, form.description);
  if (outcome === "missing") return respond(c.html(renderNotFound(ctx), 404));
  return respond(new Response(null, { status: 303, headers: { location: `${repoLinkOf(repo)}/settings/actions/runners` } }));
}

/** POST /{owner}/{repo}/settings/actions/runners/{id}/update-runner
 * (RunnerUpdatePost, runners.go:328-369): the required `disabled` flip —
 * an absent param answers upstream's exact 400 ("missing 'disabled'
 * parameter"); "updated" 303s back onto the EDIT page (upstream's
 * JSONRedirect("") stays-on-page arm, the no-JS reduction); "missing" is
 * the 404 shell. */
async function repoActionsRunnerUpdate(c: Context<{ Bindings: Env }>, runnerId: number): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const gate = await repoActionsGate(c, resolved);
  if (gate !== null) return gate;
  const { ctx, repo, respond } = resolved;
  if (resolved.route.family !== "settings-actions-runners-update") return respond(await c.notFound()); // drift guard
  const form = parseRepoActionsRunnerDisabledForm(await readUrlEncodedForm(c.req.raw));
  if (form.disabled === null) {
    return respond(new Response("missing 'disabled' parameter\n", { status: 400, headers: { "content-type": "text/plain;charset=utf-8", "x-content-type-options": "nosniff" } }));
  }
  const outcome = await setRepoActionsRunnerDisabled(c.env.DB, repo.id, runnerId, form.disabled);
  if (outcome === "missing") return respond(c.html(renderNotFound(ctx), 404));
  return respond(new Response(null, { status: 303, headers: { location: `${repoLinkOf(repo)}/settings/actions/runners/${runnerId}` } }));
}

/** POST /{owner}/{repo}/settings/actions/runners/{id}/delete
 * (RunnerDeletePost, runners.go:292-326): the scope-guarded hard delete —
 * "deleted" 303s onto the list URL; "missing" is the 404 shell (upstream's
 * findActionsRunner NotFound arm deletes nothing). */
async function repoActionsRunnerDelete(c: Context<{ Bindings: Env }>, runnerId: number): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const gate = await repoActionsGate(c, resolved);
  if (gate !== null) return gate;
  const { ctx, repo, respond } = resolved;
  if (resolved.route.family !== "settings-actions-runners-delete") return respond(await c.notFound()); // drift guard
  const outcome = await deleteRepoActionsRunner(c.env.DB, repo.id, runnerId);
  if (outcome === "missing") return respond(c.html(renderNotFound(ctx), 404));
  return respond(new Response(null, { status: 303, headers: { location: `${repoLinkOf(repo)}/settings/actions/runners` } }));
}

// ---------------------------------------------------------------------------
// The census C9 arm: the repo settings Actions GENERAL sub-tab (pages/
// repo-settings-actions-general.tsx — upstream web.go:1262-1278). Upstream's
// gate verdict ships exactly: the general page and its unit-toggle POST sit
// OUTSIDE MustEnableActions (actions.go:23-93's own comment — the disabled
// unit's re-entry), so both ride the shared settingsGate ONLY; the bare
// literal's redirect carries the unit arm INSIDE the gate (the enabled
// unit's shortcut, web.go:1266-1268).
// ---------------------------------------------------------------------------

/** GET /{owner}/{repo}/settings/actions — the bare literal's redirect onto
 *  the general sub-tab: the settingsGate, then MustEnableActions' repo-unit
 *  arm (a disabled unit answers the 404 shell), then the 303 with upstream's
 *  literal relative location bytes (REPO_ACTIONS_GENERAL_REDIRECT_TARGET). */
async function repoActionsSettingsRedirect(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const gate = await settingsGate(c, resolved);
  if (gate !== null) return gate;
  const { ctx, repo, respond } = resolved;
  if (resolved.route.family !== "settings-actions") return respond(await c.notFound()); // drift guard
  const settings = await loadRepoSettings(c.env.DB, repo.id);
  if (!settings.hasActions) return respond(c.html(renderNotFound(ctx), 404));
  return respond(new Response(null, { status: 303, headers: { location: REPO_ACTIONS_GENERAL_REDIRECT_TARGET } }));
}

/** GET /{owner}/{repo}/settings/actions/general (ActionsGeneralSettings,
 * actions.go:23-36) — the settingsGate ONLY (NO unit arm: web.go:1262-1265
 * mounts the general group OUTSIDE MustEnableActions — the disabled unit's
 * re-entry, the C8 gate's polarity inverted). */
async function repoActionsGeneralPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const gate = await settingsGate(c, resolved);
  if (gate !== null) return gate;
  const { ctx, repo, respond } = resolved;
  if (resolved.route.family !== "settings-actions-general") return respond(await c.notFound()); // drift guard
  const data = await loadRepoActionsGeneralPageData(c.env.DB, repo.id);
  return respond(c.html(renderRepoActionsGeneralPage(ctx, data), 200));
}

/** POST /{owner}/{repo}/settings/actions/general/actions_unit
 * (ActionsUnitPost, actions.go:38-93): the FormBool enable_actions toggle
 * through the landed store write; the settingsGate ONLY, then the 303 back
 * onto the general page (upstream's ctx.Redirect of the same URL). */
async function repoActionsUnitSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const gate = await settingsGate(c, resolved);
  if (gate !== null) return gate;
  const { repo, respond } = resolved;
  if (resolved.route.family !== "settings-actions-general-unit") return respond(await c.notFound()); // drift guard
  const form = parseRepoActionsUnitForm(await readUrlEncodedForm(c.req.raw));
  await applyRepoActionsUnitToggle(c.env.DB, repo.id, form);
  return respond(new Response(null, { status: 303, headers: { location: `${repoLinkOf(repo)}/settings/actions/general` } }));
}

// ---------------------------------------------------------------------------
// Window-2e folds: the branches writer forms' POST arms (the wave-63 module
// handoff — upstream web.go:1477-1486's editor middlewares: writer grant +
// RepoMustNotBeArchived + MustBeNotEmpty), replaying the API create/rename
// ops; the pulls/new redirect; the upload staging endpoints.
// ---------------------------------------------------------------------------

async function branchCreateSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const { ctx, viewer, repo, respond } = resolved;
  if (resolved.route.family !== "branch-create" || resolved.route.from === undefined) return respond(await c.notFound()); // drift guard
  if (repo.isArchived || repo.isEmpty) return respond(c.html(renderNotFound(ctx), 404));
  if (viewer.kind !== "user" || !(await canWriteRepo(c.env, repo, viewer))) {
    return respond(c.html(renderNotFound(ctx), 404));
  }
  const form = await readUrlEncodedForm(c.req.raw);
  const newName = (form.get("new_branch_name") ?? "").trim();
  const from = resolved.route.from === "" ? repo.defaultBranch : resolved.route.from;
  if (newName === "") {
    return respond(new Response(null, { status: 303, headers: { location: `${repoLinkOf(repo)}/branches?create_error=empty&name=${encodeURIComponent(newName)}` } }));
  }
  const pair = await findRepositoryById(c.env.DB, repo.id);
  if (pair === null) return respond(c.html(renderNotFound(ctx), 404));
  const reads = engineReads(c.env, pair.repo);
  const tips = refTipMap(await reads.listRefs());
  // STRICT source resolution (no default-branch fallback): upstream's
  // RepoRefByType(RefTypeBranch) 404s an unknown {from} branch in the
  // middleware (services/context/repo.go) and CreateNewBranch's
  // GetBranchExisting errors to ServerError — an unknown source is a
  // refusal, not a create at the default tip.
  const source = resolveNamedRef(tips, from);
  if (source === null) {
    return respond(new Response(null, { status: 303, headers: { location: `${repoLinkOf(repo)}/branches?create_error=missing&name=${encodeURIComponent(newName)}` } }));
  }
  if (tips.has(branchRef(newName))) {
    return respond(new Response(null, { status: 303, headers: { location: `${repoLinkOf(repo)}/branches?create_error=exists&name=${encodeURIComponent(newName)}` } }));
  }
  const result = await engineCell(c.env, pair.repo).commitApiChange({
    ref: branchRef(newName),
    expectedOldOid: ZERO_OID,
    newOid: source.target,
  });
  if (result.tag !== "committed") {
    const kind = result.tag === "invalid" ? "exists" : "error";
    return respond(new Response(null, { status: 303, headers: { location: `${repoLinkOf(repo)}/branches?create_error=${kind}&name=${encodeURIComponent(newName)}` } }));
  }
  return respond(new Response(null, { status: 303, headers: { location: `${repoLinkOf(repo)}/branches?created=${encodeURIComponent(newName)}` } }));
}

async function branchRenameSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const { ctx, viewer, repo, respond } = resolved;
  if (resolved.route.family !== "branch-rename") return respond(await c.notFound()); // drift guard
  if (repo.isArchived || repo.isEmpty) return respond(c.html(renderNotFound(ctx), 404));
  if (viewer.kind !== "user" || !(await canWriteRepo(c.env, repo, viewer))) {
    return respond(c.html(renderNotFound(ctx), 404));
  }
  const form = await readUrlEncodedForm(c.req.raw);
  const from = (form.get("from") ?? "").trim();
  const to = (form.get("to") ?? "").trim();
  const fail = (kind: string): Response =>
    respond(new Response(null, { status: 303, headers: { location: `${repoLinkOf(repo)}/branches?rename_error=${kind}&name=${encodeURIComponent(from)}` } }));
  if (from === "" || to === "") return fail("empty");
  const pair = await findRepositoryById(c.env.DB, repo.id);
  if (pair === null) return respond(c.html(renderNotFound(ctx), 404));
  const reads = engineReads(c.env, pair.repo);
  const tips = refTipMap(await reads.listRefs());
  const tip = tips.get(branchRef(from));
  if (tip === undefined) return fail("missing");
  if (from === to || tips.has(branchRef(to))) return fail("exists");
  if (from === repo.defaultBranch && !viewer.isAdmin) {
    // Upstream RenameBranch's admin-only default arm (branch.go:443-447).
    return fail("default");
  }
  const cell = engineCell(c.env, pair.repo);
  const created = await cell.commitApiChange({ ref: branchRef(to), expectedOldOid: ZERO_OID, newOid: tip.target });
  if (created.tag !== "committed") {
    if (created.tag === "invalid") throw new ApiError(409, "The branch with the same name already exists.");
    throw commitApiChangeError(created);
  }
  const removed = await cell.deleteApiRef({ ref: branchRef(from), expectedOid: tip.target });
  if (removed.tag !== "deleted") {
    const deleteError = deleteApiRefError(removed);
    if (deleteError !== null) throw deleteError;
    throw new ApiError(500, `rename cleanup failed: ${removed.tag}`);
  }
  return respond(new Response(null, { status: 303, headers: { location: `${repoLinkOf(repo)}/branches?renamed=${encodeURIComponent(to)}` } }));
}

/** The pulls/new redirect (web.go:1314 PullsNewRedirect — a pure redirect
 *  onto /compare with the query preserved). */
function pullsNewRedirect(c: Context<{ Bindings: Env }>): Response {
  const url = new URL(c.req.url);
  // slice(5): index 0 is the leading empty segment — slice(4) kept the
  // literal "new" (the issue-new matrix's RED; upstream's * param is
  // everything AFTER /pulls/new/).
  const tail = url.pathname.split("/").slice(5).join("/");
  const location = `/${url.pathname.split("/")[1]}/${url.pathname.split("/")[2]}/compare/${tail}${url.search}`;
  return new Response(null, { status: 307, headers: { location } });
}

/** The upload staging endpoints (editor_uploader.go:18-63 over the dc9ff97
 *  family; the writer predicate is the entire authorization — upstream's
 *  upload table has no repo column). */
async function uploadFileEndpoint(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const { ctx, viewer, repo, respond } = resolved;
  if (viewer.kind !== "user" || !(await canWriteRepo(c.env, repo, viewer))) {
    return respond(c.html(renderNotFound(ctx), 404));
  }
  return respond(await uploadFileToServer(c.env.REPO_PACKS, c.req.raw));
}

async function uploadRemoveEndpoint(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const { ctx, viewer, repo, respond } = resolved;
  if (viewer.kind !== "user" || !(await canWriteRepo(c.env, repo, viewer))) {
    return respond(c.html(renderNotFound(ctx), 404));
  }
  return respond(await uploadRemoveFromServer(c.env.REPO_PACKS, c.req.raw));
}

// ---------------------------------------------------------------------------
// Window-2e (pass 1): the aux/byte surfaces — sitemap XML + the two search
// JSON feeds (pages/sitemap.ts + pages/search-aux.ts).
// ---------------------------------------------------------------------------

async function sitemapRoute(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiSession(c);
  if (!resolved.ok) return resolved.response;
  const { url, respond } = resolved;
  const route = resolved.route;
  // No session gate (optExploreSignIn could only inflate counts with
  // signed-in privates; the anonymous count is the safe public ceiling —
  // the module handoff).
  if (route.family === "home-sitemap") {
    return respond(sitemapXmlResponse(await loadHomeSitemapIndex(c.env.DB, url.origin)));
  }
  if (route.family === "explore-repos-sitemap") {
    if (route.idx === undefined) return respond(await c.notFound()); // drift guard
    return respond(sitemapXmlResponse(await loadReposSitemap(c.env.DB, url.origin, route.idx)));
  }
  if (route.family === "explore-users-sitemap") {
    if (route.idx === undefined) return respond(await c.notFound()); // drift guard
    return respond(sitemapXmlResponse(await loadUsersSitemap(c.env.DB, url.origin, route.idx)));
  }
  return respond(await c.notFound()); // drift guard
}

async function repoSearchAuxRoute(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiSession(c);
  if (!resolved.ok) return resolved.response;
  const { url, viewer, respond } = resolved;
  if (resolved.route.family !== "repo-search-aux") return respond(await c.notFound()); // drift guard
  // reqSignIn (web.go:1097-1103). The API-layer Viewer needs the contract
  // User — built from the D1 row via the auth mapper (toApiUser, exported
  // for this bridge).
  if (viewer.kind === "anonymous") return respond(loginRedirect(url.pathname + url.search));
  const userRow = await drizzle(c.env.DB).select().from(users).where(eq(users.id, viewer.id)).get();
  if (userRow === undefined) return respond(c.html(renderNotFound(resolved.ctx), 404)); // the session doer vanished
  const apiViewer = {
    origin: url.origin,
    requester: toApiUser({
      id: userRow.id,
      username: userRow.username,
      usernameLower: userRow.usernameLower,
      email: userRow.email,
      displayName: userRow.displayName,
      isAdmin: userRow.isAdmin,
      status: userRow.status,
      createdAt: userRow.createdAt,
    }),
  };
  let params: ReturnType<typeof parseRepoSearchAuxQuery>;
  try {
    params = parseRepoSearchAuxQuery(url, true);
  } catch (error) {
    if (error instanceof SearchAuxParamError) {
      // Upstream ctx.HTTPError: the status + the plain message, HTML page —
      // never JSON.
      return respond(new Response(error.message, { status: 422, headers: { "content-type": "text/plain; charset=utf-8" } }));
    }
    throw error;
  }
  const result = await loadRepoSearchAux(c.env, apiViewer, params);
  return respond(
    params.countOnly
      ? repoSearchCountOnlyResponse(result.total)
      : repoSearchAuxResponse(result.total, { ok: true, data: result.data } satisfies WebSearchAuxResults),
  );
}

async function topicSearchAuxRoute(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiSession(c);
  if (!resolved.ok) return resolved.response;
  const { url, respond } = resolved;
  if (resolved.route.family !== "explore-topic-search-aux") return respond(await c.notFound()); // drift guard
  // optSignIn — no gate.
  const params = parseTopicSearchAuxQuery(url);
  const result = await loadTopicSearchAux(c.env, params);
  return respond(topicSearchAuxResponse(result.total, { topics: result.topics }));
}

/** Window-2e C3: GET+POST /repo/migrate (pages/repo-migrate.tsx — reqSignIn;
 *  the mirror checkbox is the only offered arm; the population is the
 *  enqueued mirror-sync, never in-request). */
async function repoMigratePage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiSession(c);
  if (!resolved.ok) return resolved.response;
  const { url, ctx, viewer, respond } = resolved;
  if (resolved.route.family !== "repo-migrate") return respond(await c.notFound()); // drift guard
  if (viewer.kind === "anonymous") return respond(loginRedirect(url.pathname + url.search));
  const data = await loadRepoMigrateData(c.env.DB, viewer);
  if (data === null) return respond(c.html(renderNotFound(ctx), 404));
  return respond(c.html(renderRepoMigratePage({ ctx, data, form: { uid: null, cloneAddr: "", authUsername: "", authPassword: "", repoName: "", description: "", isPrivate: false, mirror: true }, error: null }), 200));
}

async function repoMigrateSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveUiSession(c);
  if (!resolved.ok) return resolved.response;
  const { url, ctx, viewer, respond } = resolved;
  if (resolved.route.family !== "repo-migrate") return respond(await c.notFound()); // drift guard
  if (viewer.kind === "anonymous") return respond(loginRedirect(url.pathname + url.search));
  const data = await loadRepoMigrateData(c.env.DB, viewer);
  if (data === null) return respond(c.html(renderNotFound(ctx), 404));
  const form = parseRepoMigrateForm(await readUrlEncodedForm(c.req.raw));
  const result = await migrateRepoFromForm(c.env, c.env.DB, viewer, data, form, { request: c, origin: ctx.origin });
  if (result.outcome === "created") {
    return respond(
      new Response(null, { status: 303, headers: { location: `/${result.ownerNamespace}/${result.slug}` } }),
    );
  }
  return respond(c.html(renderRepoMigratePage({ ctx, data, form, error: result.message }), 200));
}

/** Window-2e: the .rss/.atom envelopes — resolve the owner through the
 *  activity-feeds seam (org-then-user, visibility-gated), then the byte
 *  render with the gorilla-parity content types. */
async function userFeedRoute(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiSession(c);
  if (!resolved.ok) return resolved.response;
  const { url, ctx, viewer, respond } = resolved;
  const route = resolved.route;
  if (route.family !== "user-feed-rss" && route.family !== "user-feed-atom") return respond(await c.notFound()); // drift guard
  const doer = orgFamilyDoer(viewer);
  const resolution = await resolveActivityFeeds(c.env.DB, route.owner, doer, url.pathname, url.search);
  if (resolution.kind === "redirect") {
    return respond(new Response(null, { status: 307, headers: { location: resolution.location } }));
  }
  if (resolution.kind === "missing") return respond(c.html(renderNotFound(ctx), 404));
  const subject =
    resolution.kind === "org"
      ? {
          kind: "org" as const,
          id: resolution.org.id,
          username: resolution.org.username,
          fullName: resolution.org.fullName,
          email: resolution.org.email,
          description: resolution.org.description,
        }
      : {
          kind: "user" as const,
          id: resolution.user.id,
          username: resolution.user.username,
          fullName: resolution.user.fullName,
          email: resolution.user.email,
          description: resolution.user.description,
        };
  // The route clock (the seam at the top) flows into the channel Created
  // stamp — the loader's trailing `now` seam from the wallclock audit.
  const data = await loadUserFeedData(c.env.DB, subject, viewer, url.origin, url.searchParams, routeNow());
  const body = route.family === "user-feed-rss" ? renderUserFeedRss(data) : renderUserFeedAtom(data);
  return respond(
    new Response(body, {
      headers: { "content-type": route.family === "user-feed-rss" ? USER_FEED_CONTENT_TYPES.rss : USER_FEED_CONTENT_TYPES.atom },
    }),
  );
}

// ---------------------------------------------------------------------------
// Window-2e B2: the repo-scoped aux feeds + fragments. All ride
// resolveUiRequest (the repo read + visibility) with per-family drift
// guards; the notFound arms re-render the §4.5 shell (renderNotFound).
// ---------------------------------------------------------------------------

async function issuesSearchAuxRoute(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const { url, ctx, repo, viewer, respond } = resolved;
  if (resolved.route.family !== "issues-search-aux") return respond(await c.notFound()); // drift guard
  if (viewer.kind !== "user") return respond(loginRedirect(url.pathname + url.search)); // reqSignIn (web.go:1440)
  const data = await loadIssuesSearchAux(
    c.env,
    { id: repo.id, isArchived: repo.isArchived },
    { id: viewer.id, username: viewer.username, isAdmin: viewer.isAdmin },
    url.origin,
    url,
  );
  return respond(issuesSearchResponse(data, renderNotFound(ctx)));
}

async function issuesSuggestionsAuxRoute(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const { respond } = resolved;
  if (resolved.route.family !== "issues-suggestions-aux") return respond(await c.notFound()); // drift guard
  // optSignIn + the viewer's unit reads — both readable while actions/
  // units are unlanded (the module's literal-true note); the raw q rides
  // UNTRIMMED (upstream FormValue).
  const suggestions = await loadIssuesSuggestionsAux(c.env, resolved.repo.id, suggestionsIsPullFilter(true, true), c.req.query("q") ?? "");
  return respond(issuesSuggestionsResponse(suggestions));
}

async function issueInfoFragmentRoute(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const { url, ctx, repo, viewer, respond } = resolved;
  const route = resolved.route;
  if (route.family !== "issue-info" || route.index === undefined || route.urlKind === undefined) return respond(await c.notFound()); // drift guard
  const data = await loadIssueInfoFragment(c.env.DB, repo, route.urlKind, route.index, url.origin, viewer, repoLinkOf(repo));
  return respond(issueInfoFragmentResponse(data, renderNotFound(ctx)));
}

async function issueAttachmentsFragmentRoute(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const { url, ctx, repo, respond } = resolved;
  const route = resolved.route;
  if (route.family !== "issue-attachments" || route.index === undefined) return respond(await c.notFound()); // drift guard
  const issue = await resolveFragmentIssue(c.env.DB, repo, route.index);
  if (issue === null) return respond(c.html(renderNotFound(ctx), 404));
  const rows = await loadIssueAttachmentsFragment(c.env.DB, issue.id);
  return respond(issueAttachmentsFragmentResponse(url.origin, rows));
}

async function issueContentOverviewRoute(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const { ctx, repo, respond } = resolved;
  const route = resolved.route;
  if (route.family !== "issue-content-overview" || route.index === undefined) return respond(await c.notFound()); // drift guard
  const issue = await resolveFragmentIssue(c.env.DB, repo, route.index);
  if (issue === null) return respond(c.html(renderNotFound(ctx), 404));
  const data = await loadContentHistoryOverviewFragment(c.env.DB, issue);
  return respond(contentHistoryOverviewFragmentResponse(data));
}

/** GET /{issues|pulls}/{index}/content-history/list (the dropdown JSON): the
 *  overview handler's shape; `comment_id` is Go FormInt64 (missing/garbage
 *  → 0 — the module's export). */
async function issueContentHistoryListRoute(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const { ctx, repo, respond } = resolved;
  const route = resolved.route;
  if (route.family !== "issue-content-history-list" || route.index === undefined) return respond(await c.notFound()); // drift guard
  const issue = await resolveFragmentIssue(c.env.DB, repo, route.index);
  if (issue === null) return respond(c.html(renderNotFound(ctx), 404));
  const commentId = formInt64(resolved.url.searchParams.get("comment_id"));
  const data = await loadContentHistoryListFragment(c.env.DB, issue, commentId);
  return respond(contentHistoryListFragmentResponse(data));
}

/** GET /{issues|pulls}/{index}/content-history/detail (the diff JSON): the
 *  detail loader takes env FIRST (its write-grant arm rides
 *  sessionRepoGrant) and the resolved viewer. The "historyNotFound" outcome
 *  IS the JSON 404 body — do NOT substitute the HTML shell (the module's
 *  loud rule; the empty-200 comment-miss quirk rides inside the loader's
 *  ok arm). */
async function issueContentHistoryDetailRoute(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const { ctx, repo, respond, viewer } = resolved;
  const route = resolved.route;
  if (route.family !== "issue-content-history-detail" || route.index === undefined) return respond(await c.notFound()); // drift guard
  const issue = await resolveFragmentIssue(c.env.DB, repo, route.index);
  if (issue === null) return respond(c.html(renderNotFound(ctx), 404));
  const commentId = formInt64(resolved.url.searchParams.get("comment_id"));
  const historyId = formInt64(resolved.url.searchParams.get("history_id"));
  const data = await loadContentHistoryDetailFragment(c.env, repo, issue, viewer, commentId, historyId);
  return respond(contentHistoryDetailFragmentResponse(data));
}

/**
 * POST /{owner}/{repo}/{issues|pulls}/{index}/content-history/soft-delete
 * (issue_content_history.go:183-236's SoftDeleteContentHistory, web.go:1391
 * — the reqSignIn'd UPDATE group): the detail handler's shape, then the
 * module's outcome map — the notFound arm renders the HTML shell, forbidden
 * is the JSON 403, the two orphaned quirks are the EMPTY 200s, and
 * deleted/writeFailed are the `{"ok": …}` 200s (:231-235). The bundle's
 * fetch carries comment_id + history_id on the QUERY STRING
 * (repo-issue-content.ts:48), so the FormInt64 reads ride the search params
 * exactly like the detail arm.
 */
async function issueContentHistorySoftDeleteRoute(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const { ctx, repo, respond, viewer } = resolved;
  const route = resolved.route;
  if (route.family !== "issue-content-history-soft-delete" || route.index === undefined) return respond(await c.notFound()); // drift guard
  const issue = await resolveFragmentIssue(c.env.DB, repo, route.index);
  if (issue === null) return respond(c.html(renderNotFound(ctx), 404));
  const commentId = formInt64(resolved.url.searchParams.get("comment_id"));
  const historyId = formInt64(resolved.url.searchParams.get("history_id"));
  const data = await softDeleteContentHistoryFragment(c.env, repo, issue, viewer, commentId, historyId);
  return respond(contentHistorySoftDeleteFragmentResponse(data, renderNotFound(ctx)));
}

async function issueAttachmentsAliasRoute(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const { respond } = resolved;
  const route = resolved.route;
  if (route.family !== "issue-attachments-alias" || route.segment === undefined) return respond(await c.notFound()); // drift guard
  // The byte arm IS the landed site-level seam — hand off (the module's
  // documented alias, no second handler).
  return respond(new Response(null, { status: 302, headers: { location: `/attachments/${route.segment}` } }));
}

async function pullMergeBoxRoute(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const { url, ctx, repo, viewer, respond } = resolved;
  const route = resolved.route;
  if (route.family !== "pull-merge-box" || route.index === undefined) return respond(await c.notFound()); // drift guard
  const found = await findPullRequestByIndex(c.env.DB, repo.id, route.index);
  if (found === null) return respond(c.html(renderNotFound(ctx), 404));
  const data = await loadPullMergeBoxData(c.env.DB, { repo, issue: found.issue, pr: found.pullRequest, viewer, origin: url.origin });
  // null → the EMPTY fragment (upstream's ShowMergeBox=false arm — the
  // bundle's reload stop signal).
  return respond(pullMergeBoxFragmentResponse(data === null ? "" : pullMergeBoxFragmentHtml(data)));
}

async function pullFilesRangeRoute(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const { ctx, repo, respond } = resolved;
  const route = resolved.route;
  if (route.family !== "pull-files-range" || route.index === undefined || route.segment === undefined) {
    return respond(await c.notFound()); // drift guard
  }
  const data = await loadPullFilesRange(c, repo.id, route.index, route.segment);
  if (data === null) return respond(c.html(renderNotFound(ctx), 404));
  return respond(c.html(renderPullFilesRangePage({ ctx, data })));
}

async function pullCommitFilesRoute(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const { ctx, repo, respond } = resolved;
  const route = resolved.route;
  if (route.family !== "pull-commit-files" || route.index === undefined || route.segment === undefined) {
    return respond(await c.notFound()); // drift guard
  }
  const data = await loadPullFilesSingleCommit(c, repo.id, route.index, route.segment);
  if (data === null) return respond(c.html(renderNotFound(ctx), 404));
  return respond(c.html(renderPullFilesSingleCommitPage({ ctx, data })));
}

async function activityAuthorDataRoute(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const { url, ctx, repo, respond } = resolved;
  const route = resolved.route;
  if (route.family !== "activity-author-data") return respond(await c.notFound()); // drift guard
  const data = await loadActivityAuthorData(
    c.env,
    { ownerNamespace: repo.ownerNamespace, slug: repo.slug, isEmpty: repo.isEmpty },
    route.segment ?? null,
    { origin: url.origin },
  );
  if (data === null) return respond(c.html(renderNotFound(ctx), 404));
  return respond(activityAuthorDataResponse(data));
}

/** GET /{owner}/{repo}/activity[/{period}] (pages/repo-activity.tsx — the
 *  census R14 pulse page, upstream repo.Activity, web.go:1629-1630 →
 *  routers/web/repo/activity.go:22-81). The shared visibility read IS the
 *  group's RequireUnitReader gate (the code unit has no toggle — the module
 *  doc); `MustBeNotEmpty` 404-shells empty repos (web.go:1636) and the
 *  loader's null answers the default-branch-miss arm (activity.go:51-60's
 *  `default_branch_not_exist` NotFound) plus the engine-transport 404
 *  (the commits-page convention). */
async function repoActivityPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const { ctx, repo, respond } = resolved;
  const route = resolved.route;
  if (route.family !== "repo-activity") return respond(await c.notFound()); // drift guard
  if (repo.isEmpty) return respond(c.html(renderNotFound(ctx), 404)); // MustBeNotEmpty (web.go:1636)
  const data = await loadRepoActivityData(c.env, repo, route.period, { now: routeNow() });
  if (data === null) return respond(c.html(renderNotFound(ctx), 404)); // the default-branch arm
  return respond(c.html(renderRepoActivityPage(ctx, data), 200));
}

/** GET /{owner}/{repo}/activity/{contributors|code-frequency|recent-commits}
 *  (pages/repo-charts.tsx — the census R15 chart pages, web.go:1635/1639/1643
 *  → repo.Contributors/CodeFrequency/RecentCommits, all rendering the
 *  repo/activity template). The shared visibility read IS the chart group's
 *  gates (the group middleware + reqUnitCodeReader, web.go:1646-1649 — the
 *  code unit has no landed toggle, the repo-activity precedent);
 *  `MustBeNotEmpty` 404-shells empty repos (web.go:1648). */
async function repoChartPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const { ctx, repo, respond } = resolved;
  const route = resolved.route;
  if (route.family !== "repo-charts" || route.tail !== null) return respond(await c.notFound()); // drift guard
  if (repo.isEmpty) return respond(c.html(renderNotFound(ctx), 404)); // MustBeNotEmpty (web.go:1648)
  const html =
    route.kind === "contributors"
      ? renderRepoContributorsPage(ctx)
      : route.kind === "code-frequency"
        ? renderRepoCodeFrequencyPage(ctx)
        : renderRepoRecentCommitsPage(ctx);
  return respond(c.html(html, 200));
}

/** GET …/activity/{contributors|code-frequency|recent-commits}/data (the R15
 *  JSON tails, web.go:1636/1640/1644): contributors serves the FULL
 *  ContributorData map (the "total" pseudo-entry included,
 *  contributors.go:36); code-frequency AND recent-commits serve the same
 *  total-weeks object (upstream registers repo.CodeFrequencyData for both —
 *  web.go:1644's own comment). The loader's null (unresolvable ref /
 *  transport failure — the aux-JSON convention) 404-shells; upstream would
 *  ServerError 500 there, the documented divergence. Our synchronous RPC
 *  never answers upstream's 202 ErrAwaitGeneration (the ratified no-pre-warm
 *  posture — the module header). */
async function repoChartDataRoute(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const { url, ctx, repo, respond } = resolved;
  const route = resolved.route;
  if (route.family !== "repo-charts" || route.tail !== "data") return respond(await c.notFound()); // drift guard
  if (repo.isEmpty) return respond(c.html(renderNotFound(ctx), 404)); // MustBeNotEmpty (web.go:1648)
  if (route.kind === "contributors") {
    const data = await loadRepoContributorsData(c.env, repo, { origin: url.origin });
    if (data === null) return respond(c.html(renderNotFound(ctx), 404));
    return respond(chartDataResponse(data));
  }
  const data = await loadChartFrequencyData(c.env, repo);
  if (data === null) return respond(c.html(renderNotFound(ctx), 404));
  return respond(chartDataResponse(data));
}

/** GET /{owner}/{repo}/search (pages/repo-search.tsx — the census R10 code
 *  search page, upstream web.go:1768 → routers/web/repo/search.go:22-68).
 *  The shared visibility read IS the group's reqUnitCodeReader gate (the
 *  code unit has no toggle — the repo-activity precedent); the bare-form arm
 *  (`q` empty) renders WITHOUT any engine call, upstream-exact
 *  (search.go:25-28 returns before the ref resolution), so an empty repo
 *  still renders the form; a keyword search on an unresolvable default
 *  branch 404-shells (the loader's null — upstream ServerErrors the unborn
 *  branch, gitgrep.go:63's TODO, the documented reduction). */
async function repoSearchPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const { url, ctx, repo, respond } = resolved;
  const route = resolved.route;
  if (route.family !== "repo-search") return respond(await c.notFound()); // drift guard
  const data = await loadRepoSearchData(engineClient(c.env, `${repo.ownerNamespace}/${repo.slug}`), repo, url.searchParams);
  if (data === null) return respond(c.html(renderNotFound(ctx), 404));
  return respond(c.html(renderRepoSearchPage({ ctx, data }), 200));
}

/** GET /{owner}/{repo}/graph (pages/repo-graph.tsx — the census R09-M2
 *  commit-graph page, upstream web.go:1738 → commit.go:106-173). The shared
 *  visibility read IS the bare group's middleware gate (ours reduces to the
 *  visibility read, the repo-activity precedent); `MustBeNotEmpty`
 *  404-shells empty repos (web.go:1737) and the loader's null answers the
 *  unborn-HEAD ladder plus the engine-transport 404 (the activity-page
 *  posture). One handler answers BOTH arms: the full page and the
 *  `?div-only=true` body fragment (commit.go:170-173's tplGraphDiv — the
 *  official bundle's refresh fetch; the pager links strip the param,
 *  commit.go:169's RemoveParam). */
async function repoGraphPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const { url, ctx, repo, respond } = resolved;
  const route = resolved.route;
  if (route.family !== "graph") return respond(await c.notFound()); // drift guard
  if (repo.isEmpty) return respond(c.html(renderNotFound(ctx), 404)); // MustBeNotEmpty (web.go:1737)
  const query = parseGraphQuery(url.searchParams);
  const data = await loadGraphData(engineClient(c.env, `${repo.ownerNamespace}/${repo.slug}`), query);
  if (data === null) return respond(c.html(renderNotFound(ctx), 404));
  const repoLink = `/${repo.ownerNamespace}/${repo.slug}`;
  return respond(
    query.divOnly ? c.html(renderGraphFragment(repoLink, data), 200) : c.html(renderRepoGraphPage(ctx, data), 200),
  );
}

/** GET /{owner}/{repo}/comments/{id}/attachments (the fragment module's
 *  mount record, web.go:1337): the repo-level comments head, GET-only; the
 *  404 shells and the type-gate 500 live in the module's outcome union. */
async function commentAttachmentsRoute(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const { url, ctx, repo, respond } = resolved;
  const route = resolved.route;
  if (route.family !== "comment-attachments") return respond(await c.notFound()); // drift guard
  const outcome = await loadCommentAttachmentsFragment(c.env.DB, repo, route.segment ?? "");
  return respond(commentAttachmentsFragmentResponse(url.origin, outcome, renderNotFound(ctx)));
}

/** GET /{owner}/{repo}/settings/hooks (pages/settings.tsx — the webhooks
 *  list + add form). */
async function hooksSettingsPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const gate = await settingsGate(c, resolved);
  if (gate !== null) return gate;
  const data = await loadHooksSettings(c.env.DB, resolved.repo.id);
  return resolved.respond(c.html(renderHooksSettingsPage({ ctx: resolved.ctx, data, error: null }), 200));
}

/** POST /{owner}/{repo}/settings/hooks — the add-hook write through the
 *  landed `createRepoHook`; success 303s back onto the list, the service's
 *  validation message re-renders the form with the submission kept. */
async function hooksSettingsSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const gate = await settingsGate(c, resolved);
  if (gate !== null) return gate;
  const { ctx, repo, respond } = resolved;
  const form = parseCreateHookForm(await readUrlEncodedForm(c.req.raw));
  const result = await createHookFromForm(c.env.DB, repo.id, form);
  if (result.outcome === "created") {
    return respond(
      new Response(null, { status: 303, headers: { location: `/${repo.ownerNamespace}/${repo.slug}/settings/hooks` } }),
    );
  }
  const data = await loadHooksSettings(c.env.DB, repo.id);
  data.form = { name: form.name, payloadUrl: form.payloadUrl, contentType: form.contentType };
  return respond(c.html(renderHooksSettingsPage({ ctx, data, error: result.message }), 200));
}

/** GET /{owner}/{repo}/settings/mirror (pages/settings.tsx — the wave-10
 *  mirror panel; the settings gate + `?sync=queued` flash reduction). */
async function mirrorSettingsPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const gate = await settingsGate(c, resolved);
  if (gate !== null) return gate;
  const syncQueued = resolved.url.searchParams.get("sync") === "queued";
  const data = await loadMirrorSettings(c.env.DB, resolved.repo.id, syncQueued);
  return resolved.respond(c.html(renderMirrorSettingsPage({ ctx: resolved.ctx, data, error: null }), 200));
}

/**
 * POST /{owner}/{repo}/settings/mirror — Synchronize Now (upstream
 * handleSettingsPostMirrorSync, setting.go:379-390): the mirror-sync enqueue
 * through syncMirrorNow; success 303s back with the `?sync=queued` flash
 * (upstream's Flash.Info + Redirect), the not-a-mirror/archived refusals
 * 404-shell exactly upstream's NotFound arm, the queue-side failures answer
 * the gate's 500 plain-text shape.
 */
async function mirrorSyncSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const gate = await settingsGate(c, resolved);
  if (gate !== null) return gate;
  const { ctx, repo, respond } = resolved;
  const result = await syncMirrorNow(c.env.DB, c.env.MIRROR_SYNC_QUEUE, repo);
  if (result.outcome === "queued") {
    return respond(
      new Response(null, {
        status: 303,
        headers: { location: `/${repo.ownerNamespace}/${repo.slug}/settings/mirror?sync=queued` },
      }),
    );
  }
  if (result.outcome === "not-mirror" || result.outcome === "archived") {
    return respond(c.html(renderNotFound(ctx), 404));
  }
  const message = result.outcome === "no-queue" ? mirrorLocale.queue_missing : "mirror sync enqueue failed";
  return new Response(`${message}\n`, {
    status: 500,
    headers: { "content-type": "text/plain;charset=utf-8", "x-content-type-options": "nosniff" },
  });
}

// ---------------------------------------------------------------------------
// The wave-14 per-hook family (pages/settings.tsx — upstream WebHooksEdit /
// GiteaHooksEditPost / TestWebhook / DeleteWebhook)
// ---------------------------------------------------------------------------

/** GET /{owner}/{repo}/settings/hooks/{id} (pages/settings.tsx — the edit
 *  form + the recent-deliveries list; `?test=queued` renders the flash
 *  reduction's info message). The settings gate's order (repo → anonymous
 *  login 303 → signed-in non-admin 404 shell), the drift guard, then the
 *  repo-scoped hook read — an unknown or foreign-repo id 404-shells (the
 *  landed repoGetHook arm). */
async function hookDetailPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const gate = await settingsGate(c, resolved);
  if (gate !== null) return gate;
  const { url, ctx, respond } = resolved;
  const route = resolved.route;
  if (route.family !== "settings-hook-detail" || route.id === undefined) return respond(await c.notFound()); // drift guard
  const data = await loadHookDetailData(c.env.DB, resolved.repo.id, route.id);
  if (data === null) return respond(c.html(renderNotFound(ctx), 404));
  const testQueued = url.searchParams.get("test") === "queued";
  return respond(c.html(renderHookDetailPage({ ctx, data, error: null, testQueued }), 200));
}

/**
 * POST /{owner}/{repo}/settings/hooks/{id} — the edit write (upstream
 * GiteaHooksEditPost over the landed PATCH arm's service call): success 303s
 * back onto the page (upstream editWebhook's redirect), the 422
 * validations re-render at 200 with the message and the kept submission
 * (the login failure convention). The POST rides the page URL — upstream
 * type-prefixes it (`/gitea/{id}`); the module header's divergence note.
 */
async function hookDetailSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const gate = await settingsGate(c, resolved);
  if (gate !== null) return gate;
  const { ctx, repo, respond } = resolved;
  const route = resolved.route;
  if (route.family !== "settings-hook-detail" || route.id === undefined) return respond(await c.notFound()); // drift guard
  const hook = await getRepoHook(c.env.DB, repo.id, route.id);
  if (hook === null) return respond(c.html(renderNotFound(ctx), 404));
  const hookLink = `${repoLinkOf(repo)}/settings/hooks/${hook.id}`;
  const form = parseHookEditForm(await readUrlEncodedForm(c.req.raw));
  const result = await editHookFromForm(c.env.DB, hook, form);
  if (result.outcome === "saved") {
    return respond(new Response(null, { status: 303, headers: { location: hookLink } }));
  }
  const data = await loadHookDetailData(c.env.DB, repo.id, hook.id);
  if (data === null) return respond(c.html(renderNotFound(ctx), 404));
  data.form = form;
  return respond(c.html(renderHookDetailPage({ ctx, data, error: result.message, testQueued: false }), 200));
}

/** The resolved repo row's canonical link (the handlers' `RepoLink`). */
function repoLinkOf(repo: RepoRow): string {
  return `/${repo.ownerNamespace}/${repo.slug}`;
}

/**
 * POST /{owner}/{repo}/settings/hooks/{id}/test — the test-fire write
 * (upstream TestWebhook's literal tail over the landed repoTestHook arm's
 * steps): an empty repository fires nothing (the arm's early-204 answered
 * as a silent 303 back), then the representative push payload is built and
 * the delivery row inserted through fireHookTestDelivery — the Queue
 * enqueue rides c.executionCtx.waitUntil when the producer binding exists
 * (routes/hooks.ts's structural probe; VALUE-position access — never name
 * ExecutionContext in type position). Success 303s back with
 * `?test=queued` (the flash reduction).
 */
async function hookTestSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const gate = await settingsGate(c, resolved);
  if (gate !== null) return gate;
  const { ctx, viewer, repo, respond } = resolved;
  const route = resolved.route;
  if (route.family !== "settings-hook-test" || route.id === undefined) return respond(await c.notFound()); // drift guard
  const hook = await getRepoHook(c.env.DB, repo.id, route.id);
  if (hook === null) return respond(c.html(renderNotFound(ctx), 404));
  const hookLink = `${repoLinkOf(repo)}/settings/hooks/${hook.id}`;
  // The landed arm's empty-repo no-fire (TestHook's ctx.Repo.Commit == nil
  // early-204 — the services/hooks.ts header).
  if (repo.isEmpty) return respond(new Response(null, { status: 303, headers: { location: hookLink } }));
  const pair = await findRepositoryById(c.env.DB, repo.id);
  if (pair === null) return respond(c.html(renderNotFound(ctx), 404));
  if (viewer.kind !== "user") return respond(c.html(renderNotFound(ctx), 404)); // the gate above admitted only users
  const userRow = await drizzle(c.env.DB).select().from(users).where(eq(users.id, viewer.id)).get();
  if (userRow === undefined) return respond(c.html(renderNotFound(ctx), 404)); // the session doer vanished
  let waitUntil: ((promise: Promise<unknown>) => void) | undefined;
  try {
    waitUntil = c.executionCtx.waitUntil.bind(c.executionCtx);
  } catch {
    waitUntil = undefined; // in-process test callers have none (the pending D1 row is the truth)
  }
  await fireHookTestDelivery({
    d1: c.env.DB,
    hook,
    pair,
    user: userRow,
    origin: resolved.url.origin,
    queue: hookDeliveryQueueOf(c.env),
    waitUntil,
  });
  return respond(new Response(null, { status: 303, headers: { location: `${hookLink}?test=queued` } }));
}

/**
 * POST /{owner}/{repo}/settings/hooks/{id}/delete — upstream
 * DeleteWebhook's write (the landed deleteRepoHook arm): success 303s onto
 * the hooks list (upstream JSONRedirect's target); a miss 404-shells (the
 * landed DELETE arm's 404 — existence stays hidden).
 */
async function hookDeleteSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const gate = await settingsGate(c, resolved);
  if (gate !== null) return gate;
  const { ctx, repo, respond } = resolved;
  const route = resolved.route;
  if (route.family !== "settings-hook-delete" || route.id === undefined) return respond(await c.notFound()); // drift guard
  const deleted = await deleteRepoHook(c.env.DB, repo.id, route.id);
  if (!deleted) return respond(c.html(renderNotFound(ctx), 404));
  return respond(new Response(null, { status: 303, headers: { location: `${repoLinkOf(repo)}/settings/hooks` } }));
}

/** GET on a POST-only family — upstream chi answers 405 for a registered
 *  path with the wrong method (the gate's plainTextInternal shape). */
function methodNotAllowed(allow: string): Response {
  return new Response("Method Not Allowed\n", {
    status: 405,
    headers: { "content-type": "text/plain;charset=utf-8", allow, "x-content-type-options": "nosniff" },
  });
}

// ---------------------------------------------------------------------------
// The wave-15 protected-branches family (pages/branch-protection.tsx —
// upstream's /settings/branches group, web.go:1206-1212, over the landed
// branch_protections API arms)
// ---------------------------------------------------------------------------

/** GET /{owner}/{repo}/settings/branches (pages/branch-protection.tsx — the
 *  rules list; the settings gate's order, the `?rule_name=` save-flash
 *  reduction display-only). */
async function branchProtectionListPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const gate = await settingsGate(c, resolved);
  if (gate !== null) return gate;
  const { url, ctx, repo, respond } = resolved;
  // The saved-rule flash rides the save POST's redirect target (upstream's
  // exact `?rule_name=` target, protected_branch.go:337); display-only.
  const savedRule = url.searchParams.get("rule_name");
  // An archived repo renders the warning instead of the list — the rows
  // need not load (branches.tmpl's IsArchived arm).
  const rules = repo.isArchived ? [] : await loadBranchProtectionRules(c.env.DB, repo.id);
  return respond(
    c.html(
      renderBranchProtectionListPage({
        ctx,
        data: {
          rules,
          isOrg: await loadOwnerIsOrg(c.env.DB, repo),
          savedRule: savedRule ?? null,
          // The default-branch select's options (ce52935's mount — the
          // archived arm renders neither segment, branches.tmpl's wrap).
          branchOptions: repo.isArchived ? [] : await loadDefaultBranchOptions(c.env, repo),
          // The nav's conditional Actions block flag (navbar.tmpl:47 — the
          // settings.tsx hasActions prop).
          hasActions: (await loadRepoSettings(c.env.DB, repo.id)).hasActions,
        },
      }),
      200,
    ),
  );
}

/** GET /{owner}/{repo}/settings/branches/edit (pages/branch-protection.tsx —
 *  the create/edit form; `?rule_name=` keys the rule under edit, an unknown
 *  or foreign name falls back to the CREATE form exactly like upstream's
 *  SettingsProtectedBranch nil-rule arm). */
async function branchProtectionEditPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const gate = await settingsGate(c, resolved);
  if (gate !== null) return gate;
  const { url, ctx, repo, respond } = resolved;
  const pair = await findRepositoryById(c.env.DB, repo.id);
  if (pair === null) return respond(c.html(renderNotFound(ctx), 404));
  const isOrg = await loadOwnerIsOrg(c.env.DB, repo);
  // Archived repos render the warning instead of the form (the module
  // header — the POST could only 404).
  if (repo.isArchived) {
    return respond(
      c.html(
        renderBranchProtectionEditPage({
          ctx,
          data: { form: emptyBranchProtectionForm(), isOrg, rule: null, hasActions: (await loadRepoSettings(c.env.DB, repo.id)).hasActions },
          error: null,
        }),
        200,
      ),
    );
  }
  const ruleName = url.searchParams.get("rule_name") ?? "";
  const rule = ruleName === "" ? null : (await loadBranchProtectionRules(c.env.DB, repo.id)).find((item) => item.row.ruleName === ruleName) ?? null;
  const form = rule === null ? emptyBranchProtectionForm() : await editFormOfRule(c.env.DB, pair, rule);
  // The nav's conditional Actions block flag (navbar.tmpl:47).
  return respond(
    c.html(renderBranchProtectionEditPage({ ctx, data: { form, isOrg, rule, hasActions: (await loadRepoSettings(c.env.DB, repo.id)).hasActions }, error: null }), 200),
  );
}

/**
 * POST /{owner}/{repo}/settings/branches/edit — the create-or-edit write
 * (upstream SettingsProtectedBranchPost over the landed create/PATCH arms;
 * pages/branch-protection.tsx's header carries the arm-by-arm citations):
 * the hidden rule_id splits the arms, the 403/422 messages re-render the
 * form with the kept submission (the login failure convention), success
 * 303s onto `/settings/branches?rule_name=<saved>` — upstream's exact
 * redirect target. An edit id that is missing or foreign 404-shells
 * (existence hidden, the hook-detail posture).
 */
async function branchProtectionEditSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const gate = await settingsGate(c, resolved);
  if (gate !== null) return gate;
  const { ctx, repo, respond } = resolved;
  if (repo.isArchived) return respond(c.html(renderNotFound(ctx), 404)); // RepoMustNotBeArchived
  const pair = await findRepositoryById(c.env.DB, repo.id);
  if (pair === null) return respond(c.html(renderNotFound(ctx), 404));
  const isOrg = await loadOwnerIsOrg(c.env.DB, repo);
  const form = parseBranchProtectionForm(await readUrlEncodedForm(c.req.raw));
  const result = await applyBranchProtectionForm(c.env.DB, pair, form);
  if (result.outcome === "created" || result.outcome === "saved") {
    return respond(
      new Response(null, {
        status: 303,
        headers: { location: `/${repo.ownerNamespace}/${repo.slug}/settings/branches?rule_name=${encodeURIComponent(result.ruleName)}` },
      }),
    );
  }
  if (result.outcome === "missing") return respond(c.html(renderNotFound(ctx), 404));
  // The invalid re-render keeps the submission (the login failure
  // convention); the rule binding stays whatever the form's rule_id says —
  // a validation re-render of an EDIT keeps the edit header only when the
  // row actually resolved, which the apply call just proved it did not need.
  const ruleId = form.ruleId;
  const rule =
    ruleId === 0
      ? null
      : ((await loadBranchProtectionRules(c.env.DB, repo.id)).find((item) => item.row.id === ruleId) ?? null);
  const data: BranchProtectionEditData = {
    form,
    isOrg,
    rule,
    // The nav's conditional Actions block flag (navbar.tmpl:47).
    hasActions: (await loadRepoSettings(c.env.DB, repo.id)).hasActions,
  };
  return respond(c.html(renderBranchProtectionEditPage({ ctx, data, error: result.message }), 200));
}

/**
 * POST /{owner}/{repo}/settings/branches/{id}/delete — the delete write
 * (upstream DeleteProtectedBranchRulePost's literal route over the landed
 * DELETE arm): success 303s onto the list (upstream's JSONRedirect target),
 * a missing/foreign id 404-shells (the arm's 404 — existence stays hidden).
 */
async function branchProtectionDeleteSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const gate = await settingsGate(c, resolved);
  if (gate !== null) return gate;
  const { ctx, repo, respond } = resolved;
  const route = resolved.route;
  if (route.family !== "settings-branch-delete" || route.id === undefined) return respond(await c.notFound()); // drift guard
  if (repo.isArchived) return respond(c.html(renderNotFound(ctx), 404)); // RepoMustNotBeArchived posture
  const pair = await findRepositoryById(c.env.DB, repo.id);
  if (pair === null) return respond(c.html(renderNotFound(ctx), 404));
  const deleted = await deleteRuleById(c.env.DB, pair, route.id);
  if (!deleted) return respond(c.html(renderNotFound(ctx), 404));
  return respond(new Response(null, { status: 303, headers: { location: `/${repo.ownerNamespace}/${repo.slug}/settings/branches` } }));
}

/**
 * POST /{owner}/{repo}/settings/branches/priority — the reorder write
 * (upstream UpdateBranchProtectionPriories' literal route over the landed
 * priority op): the repeated `ids` fields carry the full reordered id list
 * (the no-JS form's `{ids}` shape — pages/branch-protection.tsx's header);
 * success 303s back onto the list (upstream's JS reloads the page).
 */
async function branchProtectionPrioritySubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const gate = await settingsGate(c, resolved);
  if (gate !== null) return gate;
  const { repo, respond } = resolved;
  if (repo.isArchived) return respond(c.html(renderNotFound(resolved.ctx), 404)); // RepoMustNotBeArchived (wraps upstream's route)
  await reorderRules(c.env.DB, repo.id, parsePriorityIds(await readUrlEncodedForm(c.req.raw)));
  return respond(new Response(null, { status: 303, headers: { location: `/${repo.ownerNamespace}/${repo.slug}/settings/branches` } }));
}

// ---------------------------------------------------------------------------
// The wave-16 branches family (pages/branches.tsx — upstream's
// `m.Get("/branches", repo.Branches)` list + `m.Post("/branches/delete",
// repo.DeleteBranchPost)` write, web.go:1478-1482's group)
// ---------------------------------------------------------------------------

/** GET /{owner}/{repo}/branches (pages/branches.tsx — the list): every
 *  viewer who can see the repo reads it (anonymous-capable — the page's
 *  controls gate themselves on the loaded grants); `?q=` filters, `?page=`
 *  paginates, and the deletion-flash params are display-only. */
async function branchesPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const { url, ctx, viewer, repo, respond } = resolved;
  const route = resolved.route;
  if (route.family !== "branches") return respond(await c.notFound()); // registration/parser drift guard
  const page = parsePageNumber(url.searchParams.get("page"));
  const keyword = (url.searchParams.get("q") ?? "").slice(0, 255);
  const data = await loadBranchesData(c.env, c.env.DB, repo, { page, keyword, viewer });
  // The Switch Default Branch link rides the settings page's own gate
  // (pages/branches.tsx's divergence note — upstream gates on IsWriter).
  const canAdmin = await canAdminRepo(c.env, repo, viewer);
  return respond(
    c.html(
      renderBranchesPage({
        ctx,
        data,
        canAdmin,
        flash: {
          deleted: url.searchParams.get("deleted"),
          errorKind: url.searchParams.get("delete_error"),
          errorName: url.searchParams.get("name") ?? "",
        },
      }),
      200,
    ),
  );
}

/**
 * POST /{owner}/{repo}/branches/delete — the delete write (upstream
 * DeleteBranchPost's literal route over the landed API DELETE arm's steps
 * plus the M2 deletion predicate — pages/branches.tsx's module header
 * carries the why): the §2.8 Origin guard, the repo→viewer order, the
 * archived/empty 404 shells (RepoMustNotBeArchived + MustBeNotEmpty's UI
 * posture), then applyBranchDelete. Every refusal 303s back onto the list
 * with its flash param (upstream's JSONError texts), a deleted branch too
 * (the success flash); a missing branch name 404-shells (the API arm's
 * declared 404 — existence stays hidden).
 */
async function branchDeleteSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const { url, ctx, viewer, repo, respond } = resolved;
  const route = resolved.route;
  if (route.family !== "branch-delete") return respond(await c.notFound()); // registration/parser drift guard
  if (viewer.kind === "anonymous") return respond(loginRedirect(url.pathname + url.search));
  if (repo.isArchived || repo.isEmpty) return respond(c.html(renderNotFound(ctx), 404));
  const name = parseBranchDeleteForm(await readUrlEncodedForm(c.req.raw));
  if (name === "") return respond(c.html(renderNotFound(ctx), 404));
  const doerRow = await drizzle(c.env.DB).select().from(users).where(eq(users.id, viewer.id)).get();
  if (doerRow === undefined) return respond(c.html(renderNotFound(ctx), 404)); // the session doer vanished
  const pair = await findRepositoryById(c.env.DB, repo.id);
  if (pair === null) return respond(c.html(renderNotFound(ctx), 404));
  let waitUntil: ((promise: Promise<unknown>) => void) | undefined;
  try {
    waitUntil = c.executionCtx.waitUntil.bind(c.executionCtx);
  } catch {
    waitUntil = undefined; // in-process test callers have no execution context
  }
  const result = await applyBranchDelete(c.env, repo, viewer, name, { pair, doer: doerRow, origin: url.origin, waitUntil });
  if (result.outcome === "missing") return respond(c.html(renderNotFound(ctx), 404));
  const listPath = `/${repo.ownerNamespace}/${repo.slug}/branches`;
  const location =
    result.outcome === "deleted"
      ? `${listPath}?deleted=${encodeURIComponent(result.name)}`
      : `${listPath}?delete_error=${result.outcome === "refused-default" ? "default" : result.outcome === "refused-protected" ? "protected" : "failed"}&name=${encodeURIComponent(result.name)}`;
  return respond(new Response(null, { status: 303, headers: { location } }));
}

/**
 * GET /{owner} — the owner home (upstream `OwnerProfile`,
 * routers/web/user/profile.go:37): the session prologue WITHOUT the repo
 * read; the name resolves as an ORG first (pages/org-home.tsx — the
 * orgAssignment + RedirectToUser seam, then HasOrgOrUserVisible), then as a
 * USER (pages/user-profile.tsx — the type-gated user lookup, the shared
 * RedirectToUser redirect seam, then IsUserVisibleToViewer). A renamed name
 * 307s onto the new name (the shared user_redirects seam, query preserved),
 * an invisible or unknown name 404-shells — indistinguishable from missing,
 * existence never leaks.
 */
async function ownerHomePage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiSession(c);
  if (!resolved.ok) return resolved.response;
  const { url, route, ctx, viewer, respond } = resolved;
  if (route.family !== "owner-home") return respond(await c.notFound()); // registration/parser drift guard
  const doer = viewer.kind === "user" ? { id: viewer.id, isAdmin: viewer.isAdmin } : { id: null, isAdmin: false };
  const pathname = url.pathname;
  const query = url.search.startsWith("?") ? url.search.slice(1) : url.search;
  // The ORG half first (upstream ContextUser.IsOrganization's true arm): an
  // org renders the org home; its redirect arm is the shared seam.
  const org = await resolveOrgHome(c.env.DB, route.owner, doer, pathname, query);
  if (org.kind === "redirect") {
    return respond(new Response(null, { status: 307, headers: { location: org.location } }));
  }
  if (org.kind === "org") {
    const data = await loadOrgHomeData(c.env.DB, org.org, doer, url.searchParams);
    return respond(c.html(renderOrgHomePage(ctx, data), 200));
  }
  // The USER half (the false arm): a plain user renders the profile, a
  // renamed user 307s through the same seam, anything else 404-shells.
  const profile = await resolveUserProfile(c.env.DB, route.owner, doer, pathname, query);
  if (profile.kind === "redirect") {
    return respond(new Response(null, { status: 307, headers: { location: profile.location } }));
  }
  if (profile.kind === "missing") return respond(c.html(renderNotFound(ctx), 404));
  // The ACTIVITY tab (profile.go:162-190): upstream hangs the tab inside
  // the SAME profile route's user half — the org half above already ignored
  // the query (org.Home has no activity arm), the user half renders the
  // wave-50 feeds page instead of the repositories default (the module
  // header's mount record, this window's mount).
  if (url.searchParams.get("tab") === "activity") {
    const data = await loadActivityFeedsData(c.env.DB, profile.user, viewer, url.origin, url.searchParams);
    return respond(c.html(renderActivityFeedsPage(ctx, data), 200));
  }
  // The FOLLOW TABS (profile.go:121-161's followers/following arms — the
  // same profile route's user half; org names never reach here, the org
  // half above already ignored the query). Upstream renders the overview
  // header with NO active item for these two.
  if (url.searchParams.get("tab") === "followers" || url.searchParams.get("tab") === "following") {
    const data = await loadUserFollowTabsData(c.env.DB, profile.user, doer, url.searchParams);
    return respond(c.html(renderUserFollowTabsPage(ctx, data), 200));
  }
  // The STARS tab (profile.go:191-219).
  if (url.searchParams.get("tab") === "stars") {
    const data = await loadUserStarsTabData(c.env.DB, profile.user, doer, url.searchParams);
    return respond(c.html(renderUserStarsTabPage(ctx, data), 200));
  }
  // The WATCHING tab (profile.go:220-246 — upstream's DisableStars {{else}}
  // arm: by default reachable by DIRECT URL ONLY, nothing active in the
  // header).
  if (url.searchParams.get("tab") === "watching") {
    const data = await loadUserWatchingTabData(c.env.DB, profile.user, doer, url.searchParams);
    return respond(c.html(renderUserWatchingTabPage(ctx, data), 200));
  }
  const data = await loadUserProfileData(c.env.DB, profile.user, doer, url.searchParams);
  return respond(c.html(renderUserProfilePage(ctx, data), 200));
}

/** GET /{owner}/{repo}/milestones (pages/milestones.tsx — the list; every
 *  viewer who can see the repo; the write predicates ride along for the New
 *  button's admin gate and the wave-26 per-row Edit link's writer gate). */
async function milestonesPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const { url, ctx, viewer, respond, repo } = resolved;
  const data = await loadMilestonesData(c.env.DB, repo.id, url.searchParams);
  data.canWrite = await canAdminRepo(c.env, repo, viewer);
  data.canWriteIssues = await canWriteRepo(c.env, repo, viewer);
  return respond(c.html(renderMilestonesPage(ctx, data), 200));
}

/** GET /{owner}/{repo}/milestones/new (pages/milestones.tsx — the form).
 *  The settings gate's order: anonymous → the login 303 (repo resolution
 *  FIRST, so an invisible repo 404-shells before the redirect could leak
 *  it), a signed-in non-admin → the 404 shell. */
async function milestoneNewPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const gate = await settingsGate(c, resolved);
  if (gate !== null) return gate;
  return resolved.respond(
    c.html(renderNewMilestonePage({ ctx: resolved.ctx, form: { title: "", content: "", deadline: "" }, error: null }), 200),
  );
}

/**
 * POST /{owner}/{repo}/milestones/new (upstream NewMilestonePost,
 * routers/web/repo/milestone.go:107-136): the §2.8 Origin guard, the same
 * repo→gate order as the GET, then the landed `createRepoMilestone` —
 * success 303s back onto the list (`ctx.Redirect(RepoLink + "/milestones")`,
 * 303 per base.go:157); validation failures re-render the form at 200 with
 * the message and the submitted values (the login failure convention).
 * Archived repos refuse the write (upstream `context.RepoMustNotBeArchived()`
 * wraps the milestones group) with the API's exact message re-rendered.
 */
async function milestoneNewSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const gate = await settingsGate(c, resolved);
  if (gate !== null) return gate;
  const { ctx, repo, respond } = resolved;
  const form = parseMilestoneForm(await readUrlEncodedForm(c.req.raw));
  if (repo.isArchived) {
    return respond(c.html(renderNewMilestonePage({ ctx, form, error: milestonesLocale.repo_archived }), 200));
  }
  const result = await createMilestoneFromForm(c.env.DB, repo.id, form);
  if (result.outcome === "created") {
    return respond(
      new Response(null, { status: 303, headers: { location: `/${repo.ownerNamespace}/${repo.slug}/milestones` } }),
    );
  }
  return respond(c.html(renderNewMilestonePage({ ctx, form, error: result.message }), 200));
}

// ---------------------------------------------------------------------------
// The wave-12 user settings page (pages/user-settings.tsx — upstream's
// reqSignIn /user/settings)
// ---------------------------------------------------------------------------

/**
 * GET /user/settings (pages/user-settings.tsx — the profile form): the
 * session prologue WITHOUT the repo read, then the signed-in gate — an
 * anonymous viewer 303s onto the login round-trip (upstream reqSignIn), a
 * signed-in viewer manages exactly their own row. A session doer without a
 * D1 row 404-shells (the silent-auth-failure convention).
 */
async function userSettingsPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiSession(c);
  if (!resolved.ok) return resolved.response;
  const { url, ctx, viewer, respond } = resolved;
  if (viewer.kind === "anonymous") return respond(loginRedirect(url.pathname + url.search));
  const data = await loadUserSettingsPageData(c.env.DB, viewer.id);
  if (data === null) return respond(c.html(renderNotFound(ctx), 404));
  return respond(c.html(renderUserSettingsPage(ctx, data), 200));
}

/**
 * POST /user/settings — the profile write: the §2.8 Origin guard, the same
 * session→gate order as the GET, then the PATCH route's exact service
 * sequence (saveUserProfileColumns + saveUserSettings, pages/user-settings.tsx
 * module header). Always succeeds — the landed services carry no validation
 * arms — so success 303s back onto the canonical URL (upstream
 * SettingsPost's redirect; the flash reduction).
 */
async function userSettingsSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveUiSession(c);
  if (!resolved.ok) return resolved.response;
  const { url, ctx, viewer, respond } = resolved;
  if (viewer.kind === "anonymous") return respond(loginRedirect(url.pathname + url.search));
  const row = await loadUserSettingsPageData(c.env.DB, viewer.id);
  if (row === null) return respond(c.html(renderNotFound(ctx), 404));
  const form = parseUserProfileForm(await readUrlEncodedForm(c.req.raw));
  await applyUserProfileForm(c.env.DB, viewer.id, form);
  return respond(new Response(null, { status: 303, headers: { location: "/user/settings" } }));
}

// ---------------------------------------------------------------------------
// Window-2a: the user-settings tab pages (the two-stage module wave, each
// module's header recipe). Every handler follows the wave-12 prologue
// (session → signed-in gate → doer-without-row 404 shell); POSTs take
// sameOriginGuard FIRST (§2.8); invalid outcomes re-render with the
// module's structured error; success 303s onto the canonical URL unless
// the module's recipe says otherwise (applications' one-shot plaintext
// banner re-renders instead).
// ---------------------------------------------------------------------------

/** The shared tab-page session prologue: guard → session → gates, answering
 *  {viewer, respond} or a terminal Response. */
async function userSettingsTabPrologue(c: Context<{ Bindings: Env }>, withOriginGuard: boolean): Promise<
  { ok: true; url: URL; ctx: UiContext; viewer: Extract<Viewer, { kind: "user" }>; respond: (r: Response, status?: number) => Response } | { ok: false; response: Response }
> {
  if (withOriginGuard) {
    const guard = sameOriginGuard(c.req.raw);
    if (guard !== null) return { ok: false, response: guard };
  }
  const resolved = await resolveUiSession(c);
  if (!resolved.ok) return { ok: false, response: resolved.response };
  const { url, ctx, viewer, respond } = resolved;
  if (viewer.kind === "anonymous") return { ok: false, response: respond(loginRedirect(url.pathname + url.search)) };
  return { ok: true, url, ctx, viewer, respond };
}

async function userSettingsAppearancePage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const p = await userSettingsTabPrologue(c, false);
  if (!p.ok) return p.response;
  const data = await loadUserSettingsAppearancePageData(c.env.DB, p.viewer.id);
  if (data === null) return p.respond(c.html(renderNotFound(p.ctx), 404));
  return p.respond(c.html(renderUserSettingsAppearancePage(p.ctx, data), 200));
}

async function userSettingsAppearanceSubmit(
  c: Context<{ Bindings: Env }>,
  arm: "theme" | "language",
): Promise<Response> {
  const p = await userSettingsTabPrologue(c, true);
  if (!p.ok) return p.response;
  const params = await readUrlEncodedForm(c.req.raw);
  let outcome: { outcome: "saved" } | { outcome: "invalid"; message: string };
  if (arm === "theme") {
    outcome = await applyUserSettingsAppearanceThemeForm(c.env.DB, p.viewer.id, parseUserSettingsAppearanceThemeForm(params));
  } else {
    outcome = await applyUserSettingsAppearanceLanguageForm(c.env.DB, p.viewer.id, parseUserSettingsAppearanceLanguageForm(params));
  }
  if (outcome.outcome === "saved") {
    return p.respond(new Response(null, { status: 303, headers: { location: "/user/settings/appearance" } }));
  }
  const data = await loadUserSettingsAppearancePageData(c.env.DB, p.viewer.id);
  if (data === null) return p.respond(c.html(renderNotFound(p.ctx), 404));
  return p.respond(c.html(renderUserSettingsAppearancePage(p.ctx, data, { form: arm, message: outcome.message })));
}

async function userSettingsSecurityPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const p = await userSettingsTabPrologue(c, false);
  if (!p.ok) return p.response;
  const data = await loadUserSettingsSecurityPageData(c.env.DB, p.viewer.id);
  return p.respond(c.html(renderUserSettingsSecurityPage(p.ctx, data), 200));
}

async function userSettingsSecretsPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const p = await userSettingsTabPrologue(c, false);
  if (!p.ok) return p.response;
  const data = await loadUserSettingsSecretsPageData(c.env.DB, p.viewer.id);
  return p.respond(c.html(renderUserSettingsSecretsPage(p.ctx, data), 200));
}

async function userSettingsSecretsSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const p = await userSettingsTabPrologue(c, true);
  if (!p.ok) return p.response;
  const form = parseUserSettingsSecretForm(await readUrlEncodedForm(c.req.raw));
  const outcome = await applyUserSettingsSecretForm(c.env.DB, p.viewer.id, form);
  if (outcome.outcome === "saved") {
    return p.respond(new Response(null, { status: 303, headers: { location: "/user/settings/actions/secrets" } }));
  }
  const data = await loadUserSettingsSecretsPageData(c.env.DB, p.viewer.id);
  // Carried name/description only — the value textarea stays empty
  // (plaintext never enters the DOM; the module's hard rule).
  data.form = { name: form.name, data: "", description: form.description };
  return p.respond(c.html(renderUserSettingsSecretsPage(p.ctx, data, outcome.message)));
}

async function userSettingsSecretsDelete(c: Context<{ Bindings: Env }>): Promise<Response> {
  const p = await userSettingsTabPrologue(c, true);
  if (!p.ok) return p.response;
  const form = parseUserSettingsSecretDeleteForm(await readUrlEncodedForm(c.req.raw));
  await deleteUserSettingsSecret(c.env.DB, p.viewer.id, form);
  return p.respond(new Response(null, { status: 303, headers: { location: "/user/settings/actions/secrets" } }));
}

// --- the account tab (pages/user-settings-account.tsx — upstream EmailPost /
// DeleteEmail / DeleteAccount; navbar.tmpl:7-11) ----------------------------

/** GET /user/settings/account: the prologue → the page load (the doer's
 *  users ROW + the email_addresses side store — a vanished row 404-shells,
 *  the prologue family's convention). */
async function userSettingsAccountPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const p = await userSettingsTabPrologue(c, false);
  if (!p.ok) return p.response;
  const data = await loadUserSettingsAccountPageData(c.env.DB, p.viewer.id);
  if (data === null) return p.respond(c.html(renderNotFound(p.ctx), 404));
  return p.respond(c.html(renderUserSettingsAccountPage(p.ctx, data), 200));
}

/** POST /user/settings/account/email (upstream EmailPost's arms): the write
 *  apply takes the users ROW (the loader's), so the handler resolves it
 *  first; "added"/"primary"/"redirect" → 303 back, "invalid" → reload +
 *  re-render 200 with the carried email (never the password). */
async function userSettingsAccountEmailSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const p = await userSettingsTabPrologue(c, true);
  if (!p.ok) return p.response;
  const loaded = await loadUserSettingsAccountPageData(c.env.DB, p.viewer.id);
  if (loaded === null) return p.respond(c.html(renderNotFound(p.ctx), 404));
  const form = parseUserSettingsAccountEmailForm(await readUrlEncodedForm(c.req.raw));
  const outcome = await applyUserSettingsAccountEmailForm(c.env.DB, loaded.user, form);
  if (outcome.outcome !== "invalid") {
    return p.respond(new Response(null, { status: 303, headers: { location: "/user/settings/account" } }));
  }
  const data = await loadUserSettingsAccountPageData(c.env.DB, p.viewer.id);
  if (data === null) return p.respond(c.html(renderNotFound(p.ctx), 404));
  return p.respond(c.html(renderUserSettingsAccountPage(p.ctx, data, outcome.message, form.email)));
}

/** POST /user/settings/account/email/delete (upstream DeleteEmail):
 *  "deleted" AND "missing" both 303 back (the idempotent silent-303 — the
 *  secrets-delete reduction; upstream's miss is an unreachable 500). */
async function userSettingsAccountEmailDelete(c: Context<{ Bindings: Env }>): Promise<Response> {
  const p = await userSettingsTabPrologue(c, true);
  if (!p.ok) return p.response;
  const form = parseUserSettingsAccountEmailDeleteForm(await readUrlEncodedForm(c.req.raw));
  await deleteUserSettingsAccountEmail(c.env.DB, p.viewer.id, form);
  return p.respond(new Response(null, { status: 303, headers: { location: "/user/settings/account" } }));
}

/** POST /user/settings/account/delete (upstream DeleteAccount): the apply
 *  takes the users ROW; "deleted" → 303 onto `/` (the signed-out home),
 *  "invalid" → reload + re-render 200 with the message, password field
 *  EMPTY (it never enters the DOM). */
async function userSettingsAccountDelete(c: Context<{ Bindings: Env }>): Promise<Response> {
  const p = await userSettingsTabPrologue(c, true);
  if (!p.ok) return p.response;
  const loaded = await loadUserSettingsAccountPageData(c.env.DB, p.viewer.id);
  if (loaded === null) return p.respond(c.html(renderNotFound(p.ctx), 404));
  const form = parseUserSettingsAccountDeleteForm(await readUrlEncodedForm(c.req.raw));
  const outcome = await applyUserSettingsAccountDeleteForm(c.env.DB, loaded.user, form);
  if (outcome.outcome === "deleted") {
    return p.respond(new Response(null, { status: 303, headers: { location: "/" } }));
  }
  const data = await loadUserSettingsAccountPageData(c.env.DB, p.viewer.id);
  if (data === null) return p.respond(c.html(renderNotFound(p.ctx), 404));
  return p.respond(c.html(renderUserSettingsAccountPage(p.ctx, data, outcome.message)));
}

// --- the notifications tab (pages/user-settings-notifications.tsx —
// upstream NotificationsEmailPost / NotificationsActionsEmailPost;
// navbar.tmpl:12-16) ---------------------------------------------------------

/** GET /user/settings/notifications: the appearance handler's exact shape. */
async function userSettingsNotificationsPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const p = await userSettingsTabPrologue(c, false);
  if (!p.ok) return p.response;
  const data = await loadUserSettingsNotificationsPageData(c.env.DB, p.viewer.id);
  if (data === null) return p.respond(c.html(renderNotFound(p.ctx), 404));
  return p.respond(c.html(renderUserSettingsNotificationsPage(p.ctx, data), 200));
}

/** GET /user/settings/repos (web.go:734, profile.go:222-325's else arm —
 *  ALWAYS the doer's own list; GET only, the unadopted POST stays
 *  unclaimed). */
async function userSettingsReposPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const p = await userSettingsTabPrologue(c, false);
  if (!p.ok) return p.response;
  const data = await loadUserSettingsReposPageData(c.env.DB, p.viewer.id, p.url.searchParams);
  if (data === null) return p.respond(c.html(renderNotFound(p.ctx), 404));
  return p.respond(c.html(renderUserSettingsReposPage(p.ctx, data), 200));
}

/** POST /user/settings/notifications/email|actions: one submit, the arm
 *  picks the catalog (the appearance submit's arm shape); "saved" → 303
 *  back, "invalid" → reload + full-page re-render 200 with the per-form
 *  error routing (`{ form: arm, message }`). NO EnableNotifyMail /
 *  Actions-enabled 404 arms (both reduce to always-mounted, SPEC §3). */
async function userSettingsNotificationsSubmit(
  c: Context<{ Bindings: Env }>,
  arm: "email" | "actions",
): Promise<Response> {
  const p = await userSettingsTabPrologue(c, true);
  if (!p.ok) return p.response;
  const params = await readUrlEncodedForm(c.req.raw);
  const form = arm === "email" ? parseUserSettingsNotificationsEmailForm(params) : parseUserSettingsNotificationsActionsForm(params);
  const outcome =
    arm === "email"
      ? await applyUserSettingsNotificationsEmailForm(c.env.DB, p.viewer.id, form)
      : await applyUserSettingsNotificationsActionsForm(c.env.DB, p.viewer.id, form);
  if (outcome.outcome === "saved") {
    return p.respond(new Response(null, { status: 303, headers: { location: "/user/settings/notifications" } }));
  }
  const data = await loadUserSettingsNotificationsPageData(c.env.DB, p.viewer.id);
  if (data === null) return p.respond(c.html(renderNotFound(p.ctx), 404));
  return p.respond(c.html(renderUserSettingsNotificationsPage(p.ctx, data, { form: arm, message: outcome.message })));
}

async function userSettingsVariablesPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const p = await userSettingsTabPrologue(c, false);
  if (!p.ok) return p.response;
  const data = await loadUserSettingsVariablesPageData(c.env.DB, p.viewer.id);
  return p.respond(c.html(renderUserSettingsVariablesPage(p.ctx, data), 200));
}

async function userSettingsVariablesNew(c: Context<{ Bindings: Env }>): Promise<Response> {
  const p = await userSettingsTabPrologue(c, true);
  if (!p.ok) return p.response;
  const form = parseUserSettingsVariableForm(await readUrlEncodedForm(c.req.raw));
  const outcome = await applyUserSettingsVariableCreate(c.env.DB, p.viewer.id, form);
  if (outcome.outcome === "saved") {
    return p.respond(new Response(null, { status: 303, headers: { location: "/user/settings/actions/variables" } }));
  }
  const data = await loadUserSettingsVariablesPageData(c.env.DB, p.viewer.id);
  if (outcome.outcome === "invalid") {
    // The handoff's carried add values (variables render plaintext —
    // faithful to carry the triple).
    data.form = { name: form.name, data: form.data, description: form.description };
    return p.respond(c.html(renderUserSettingsVariablesPage(p.ctx, data, outcome.message)));
  }
  return p.respond(c.html(renderNotFound(p.ctx), 404));
}

async function userSettingsVariablesEdit(c: Context<{ Bindings: Env }>, id: number): Promise<Response> {
  const p = await userSettingsTabPrologue(c, true);
  if (!p.ok) return p.response;
  const form = parseUserSettingsVariableForm(await readUrlEncodedForm(c.req.raw));
  const outcome = await applyUserSettingsVariableUpdate(c.env.DB, p.viewer.id, id, form);
  if (outcome.outcome === "saved") {
    return p.respond(new Response(null, { status: 303, headers: { location: "/user/settings/actions/variables" } }));
  }
  if (outcome.outcome === "missing") {
    // Upstream's findActionsVariable misses are ctx.NotFound(nil) — a
    // genuine 404, not a flash (the module handoff's fidelity call).
    return p.respond(c.html(renderNotFound(p.ctx), 404));
  }
  const data = await loadUserSettingsVariablesPageData(c.env.DB, p.viewer.id);
  data.form = { name: form.name, data: form.data, description: form.description };
  return p.respond(c.html(renderUserSettingsVariablesPage(p.ctx, data, outcome.message)));
}

async function userSettingsVariablesDelete(c: Context<{ Bindings: Env }>, id: number): Promise<Response> {
  const p = await userSettingsTabPrologue(c, true);
  if (!p.ok) return p.response;
  const outcome = await deleteUserSettingsVariable(c.env.DB, p.viewer.id, id);
  if (outcome === "missing") return p.respond(c.html(renderNotFound(p.ctx), 404));
  return p.respond(new Response(null, { status: 303, headers: { location: "/user/settings/actions/variables" } }));
}

async function userSettingsHooksPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const p = await userSettingsTabPrologue(c, false);
  if (!p.ok) return p.response;
  const data = await loadUserSettingsHooksPageData(c.env.DB, p.viewer.id);
  return p.respond(c.html(renderUserSettingsHooksPage({ ctx: p.ctx, data, error: null })));
}

async function userSettingsHooksCreate(c: Context<{ Bindings: Env }>): Promise<Response> {
  const p = await userSettingsTabPrologue(c, true);
  if (!p.ok) return p.response;
  const form = parseCreateHookForm(await readUrlEncodedForm(c.req.raw));
  const outcome = await createUserHookFromForm(c.env.DB, p.viewer.id, form);
  if (outcome.outcome === "created") {
    return p.respond(new Response(null, { status: 303, headers: { location: "/user/settings/hooks" } }));
  }
  const data = await loadUserSettingsHooksPageData(c.env.DB, p.viewer.id);
  // The org twin's carried form (orgHooksSettingsSubmit precedent).
  data.form = { name: form.name, payloadUrl: form.payloadUrl, contentType: form.contentType };
  return p.respond(c.html(renderUserSettingsHooksPage({ ctx: p.ctx, data, error: outcome.message })));
}

async function userHookDetailPage(c: Context<{ Bindings: Env }>, hookId: number): Promise<Response> {
  const p = await userSettingsTabPrologue(c, false);
  if (!p.ok) return p.response;
  const data = await loadUserHookDetailData(c.env.DB, p.viewer.id, hookId);
  if (data === null) return p.respond(c.html(renderNotFound(p.ctx), 404));
  return p.respond(c.html(renderUserHookDetailPage({ ctx: p.ctx, data, error: null })));
}

async function userHookDetailSubmit(c: Context<{ Bindings: Env }>, hookId: number): Promise<Response> {
  const p = await userSettingsTabPrologue(c, true);
  if (!p.ok) return p.response;
  const data = await loadUserHookDetailData(c.env.DB, p.viewer.id, hookId);
  if (data === null) return p.respond(c.html(renderNotFound(p.ctx), 404));
  const form = parseHookEditForm(await readUrlEncodedForm(c.req.raw));
  const outcome = await editUserHookFromForm(c.env.DB, data.hook, form);
  if (outcome.outcome === "saved") {
    return p.respond(new Response(null, { status: 303, headers: { location: `/user/settings/hooks/${hookId}` } }));
  }
  return p.respond(c.html(renderUserHookDetailPage({ ctx: p.ctx, data, error: outcome.message })));
}

async function userHookDelete(c: Context<{ Bindings: Env }>, hookId: number): Promise<Response> {
  const p = await userSettingsTabPrologue(c, true);
  if (!p.ok) return p.response;
  const deleted = await deleteUserHook(c.env.DB, p.viewer.id, hookId);
  if (!deleted) return p.respond(c.html(renderNotFound(p.ctx), 404));
  return p.respond(new Response(null, { status: 303, headers: { location: "/user/settings/hooks" } }));
}

async function userSettingsKeysPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const p = await userSettingsTabPrologue(c, false);
  if (!p.ok) return p.response;
  const owner = await loadUserSettingsKeysOwner(c.env.DB, p.viewer.id);
  if (owner === null) return p.respond(c.html(renderNotFound(p.ctx), 404));
  const data = await loadUserSettingsKeysPageData(c.env.DB, p.viewer.id);
  return p.respond(c.html(renderUserSettingsKeysPage(p.ctx, data)));
}

async function userSettingsKeysSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const p = await userSettingsTabPrologue(c, true);
  if (!p.ok) return p.response;
  const owner = await loadUserSettingsKeysOwner(c.env.DB, p.viewer.id);
  if (owner === null) return p.respond(c.html(renderNotFound(p.ctx), 404));
  const form = parseUserSettingsKeysForm(await readUrlEncodedForm(c.req.raw));
  const outcome = form.type === "gpg"
    ? await addGpgKeyFromForm(c.env.DB, owner, form)
    : await addSshKeyFromForm(c.env.DB, owner, form);
  const data = await loadUserSettingsKeysPageData(c.env.DB, p.viewer.id);
  if (outcome.outcome === "created") {
    return p.respond(new Response(null, { status: 303, headers: { location: "/user/settings/keys" } }));
  }
  // The handoff's carried form values (upstream's browser keeps them; the
  // no-JS reduction re-renders them server-side).
  data.form = {
    title: form.title,
    content: form.type === "ssh" ? form.content : "",
    gpgContent: form.type === "gpg" ? form.content : "",
  };
  return p.respond(c.html(renderUserSettingsKeysPage(p.ctx, data, { kind: outcome.kind, message: outcome.message, field: outcome.field })));
}

async function userSettingsKeysDelete(c: Context<{ Bindings: Env }>): Promise<Response> {
  const p = await userSettingsTabPrologue(c, true);
  if (!p.ok) return p.response;
  const form = parseUserSettingsKeysDeleteForm(await readUrlEncodedForm(c.req.raw));
  if (form.type === "gpg") {
    // Idempotent by the module's port (subkeys die with the primary; a
    // miss is the stale-form arm).
    await deleteGpgKey(c.env.DB, p.viewer.id, form.id ?? 0);
    return p.respond(new Response(null, { status: 303, headers: { location: "/user/settings/keys" } }));
  }
  const outcome = await deleteSshKey(c.env.DB, p.viewer.id, form.id ?? 0);
  if (outcome === "missing") {
    // keys.go:301-303: JSONError("Failed to delete SSH key") with NO
    // redirect — the no-JS reduction re-renders the page with the line.
    const data = await loadUserSettingsKeysPageData(c.env.DB, p.viewer.id);
    return p.respond(c.html(renderUserSettingsKeysPage(p.ctx, data, { kind: "ssh", message: "Failed to delete SSH key" })));
  }
  return p.respond(new Response(null, { status: 303, headers: { location: "/user/settings/keys" } }));
}

async function userSettingsApplicationsPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const p = await userSettingsTabPrologue(c, false);
  if (!p.ok) return p.response;
  const data = await loadUserSettingsApplicationsPageData(c.env.DB, p.viewer.id, p.viewer.isAdmin);
  return p.respond(c.html(renderUserSettingsApplicationsPage(p.ctx, data)));
}

async function userSettingsApplicationsSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const p = await userSettingsTabPrologue(c, true);
  if (!p.ok) return p.response;
  const form = parseUserSettingsApplicationsForm(await readUrlEncodedForm(c.req.raw));
  const outcome = await createTokenFromForm(c.env.DB, p.viewer.id, form);
  const data = await loadUserSettingsApplicationsPageData(c.env.DB, p.viewer.id, p.viewer.isAdmin);
  if (outcome.outcome === "created") {
    // The one-shot plaintext banner: a full-page re-render carrying the
    // value exactly once (the no-fetch-action analog; no 303 — upstream's
    // flash would drop the token).
    data.newToken = outcome.plaintext;
    return p.respond(c.html(renderUserSettingsApplicationsPage(p.ctx, data)));
  }
  // The handoff's carried name (upstream's browser keeps it).
  data.form = { name: form.name };
  return p.respond(c.html(renderUserSettingsApplicationsPage(p.ctx, data, outcome.message)));
}

async function userSettingsApplicationsDelete(c: Context<{ Bindings: Env }>): Promise<Response> {
  const p = await userSettingsTabPrologue(c, true);
  if (!p.ok) return p.response;
  const form = parseUserSettingsApplicationsDeleteForm(await readUrlEncodedForm(c.req.raw));
  await revokeTokenFromForm(c.env.DB, p.viewer.id, form.id ?? 0);
  return p.respond(new Response(null, { status: 303, headers: { location: "/user/settings/applications" } }));
}

async function userSettingsOrganizationsPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const p = await userSettingsTabPrologue(c, false);
  if (!p.ok) return p.response;
  const data = await loadUserOrgsSettings(c.env.DB, p.viewer.id, p.url.searchParams);
  const error = p.url.searchParams.get("error") === "last-owner" ? "last-owner" : null;
  return p.respond(c.html(renderUserOrgsSettingsPage(p.ctx, data, { error })));
}

async function userSettingsOrganizationsLeave(c: Context<{ Bindings: Env }>): Promise<Response> {
  const p = await userSettingsTabPrologue(c, true);
  if (!p.ok) return p.response;
  const form = parseUserOrgsLeaveForm(await readUrlEncodedForm(c.req.raw));
  const outcome = await applyUserOrgsLeave(c.env.DB, p.viewer.id, form);
  const location =
    outcome.outcome === "left"
      ? "/"
      : outcome.outcome === "last-owner"
        ? "/user/settings/organization?error=last-owner"
        : "/user/settings/organization";
  return p.respond(new Response(null, { status: 303, headers: { location } }));
}

// ---------------------------------------------------------------------------
// The wave-19 creation pages (pages/repo-create.tsx + pages/org-create.tsx —
// upstream's reqSignIn /repo/create + /org/create groups, the parity
// survey's #2 authoring front door)
// ---------------------------------------------------------------------------

/**
 * GET /repo/create (pages/repo-create.tsx — upstream repo.Create,
 * routers/web/repo/repo.go:142): the session prologue WITHOUT the repo read,
 * then the signed-in gate — an anonymous viewer 303s onto the login
 * round-trip (upstream reqSignIn). A session doer without a D1 row
 * 404-shells (the silent-auth-failure convention). `?org={id}` (upstream's
 * checkContextUser arm — the dashboard widget's deep link) preselects an
 * ALLOWED owner, anything else falls back to the doer.
 */
async function repoCreatePage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiSession(c);
  if (!resolved.ok) return resolved.response;
  const { url, ctx, viewer, respond } = resolved;
  if (viewer.kind === "anonymous") return respond(loginRedirect(url.pathname + url.search));
  const data = await loadRepoCreateData(c.env.DB, viewer);
  if (data === null) return respond(c.html(renderNotFound(ctx), 404));
  const orgParam = url.searchParams.get("org") ?? "";
  const uid =
    /^\d+$/.test(orgParam) && data.owners.some((owner) => owner.id === Number.parseInt(orgParam, 10))
      ? Number.parseInt(orgParam, 10)
      : null;
  return respond(
    c.html(
      renderRepoCreatePage({
        ctx,
        data,
        // The private checkbox defaults CHECKED (the DefaultPushCreatePrivate
        // directive — pages/repo-create.tsx header); uid null = the doer.
        form: { uid, name: "", description: "", isPrivate: true, autoInit: false },
        error: null,
      }),
      200,
    ),
  );
}

/**
 * POST /repo/create (upstream repo.CreatePost, repo.go:202): the §2.8 Origin
 * guard, the same session→gate order as the GET, then the landed create arms
 * dispatched on the owner select (pages/repo-create.tsx's createRepoFromForm
 * — createUserRepository for the doer, requireCanCreateOrgRepo +
 * RepoService.create for an org, the `repository` created webhook riding
 * both). Success 303s onto the new repo's home (upstream
 * `ctx.Redirect(repo.Link())`, 303 per base.go:157); failures re-render the
 * form at 200 with the message and the submitted values (the login failure
 * convention).
 */
async function repoCreateSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveUiSession(c);
  if (!resolved.ok) return resolved.response;
  const { url, ctx, viewer, respond } = resolved;
  if (viewer.kind === "anonymous") return respond(loginRedirect(url.pathname + url.search));
  const data = await loadRepoCreateData(c.env.DB, viewer);
  if (data === null) return respond(c.html(renderNotFound(ctx), 404));
  const form = parseRepoCreateForm(await readUrlEncodedForm(c.req.raw));
  const result = await createRepoFromForm(c.env, c.env.DB, viewer, data, form, { request: c, origin: ctx.origin });
  if (result.outcome === "created") {
    return respond(
      new Response(null, { status: 303, headers: { location: `/${result.ownerNamespace}/${result.slug}` } }),
    );
  }
  return respond(c.html(renderRepoCreatePage({ ctx, data, form, error: result.message }), 200));
}

/**
 * GET /org/create (pages/org-create.tsx — upstream org.Create,
 * routers/web/org/org.go:30): the same session→gate order; the
 * CanCreateOrganization site-config gate is unreachable at the landed tier
 * (the module header), so every signed-in viewer renders the form.
 */
async function orgCreatePage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiSession(c);
  if (!resolved.ok) return resolved.response;
  const { url, ctx, viewer, respond } = resolved;
  if (viewer.kind === "anonymous") return respond(loginRedirect(url.pathname + url.search));
  return respond(
    c.html(
      renderOrgCreatePage({
        ctx,
        // The GET defaults: visibility public (upstream's
        // DefaultOrgVisibilityMode default), the permission box CHECKED
        // (upstream GET's repo_admin_change_team_access = true).
        form: { name: "", fullName: "", email: "", visibility: "public", repoAdminChangeTeamAccess: true },
        error: null,
      }),
      200,
    ),
  );
}

/**
 * POST /org/create (upstream org.CreatePost, org.go:44): the §2.8 Origin
 * guard, the same session→gate order, then the landed `POST /orgs` service
 * (`OrgService.createOrg` — the creator's owner membership rides the same
 * batch). Success 303s onto the ORG HOME `/{org}` (upstream redirects onto
 * DashboardLink — a surface this UI does not carry, the module header's
 * divergence); the typed OrgError family re-renders inline with the kept
 * submission (the login failure convention).
 */
async function orgCreateSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveUiSession(c);
  if (!resolved.ok) return resolved.response;
  const { url, ctx, viewer, respond } = resolved;
  if (viewer.kind === "anonymous") return respond(loginRedirect(url.pathname + url.search));
  if (viewer.kind !== "user") return respond(c.html(renderNotFound(ctx), 404)); // sessions are user-shaped
  const form = parseOrgCreateForm(await readUrlEncodedForm(c.req.raw));
  const result = await createOrgFromForm(c.env.DB, viewer, form);
  if (result.outcome === "created") {
    return respond(new Response(null, { status: 303, headers: { location: `/${result.org.username}` } }));
  }
  return respond(c.html(renderOrgCreatePage({ ctx, form, error: result.message }), 200));
}

// ---------------------------------------------------------------------------
// The wave-12 org teams family (pages/org-teams.tsx — upstream's
// /{org}/teams group, web.go:993-1013)
// ---------------------------------------------------------------------------

/** The org-teams prologue the four handlers share (the settings gate's shape
 *  over the org resolution): the session half, the owner-segment drift
 *  guard, the org resolution (a renamed org 307s onto the new name, an
 *  unknown name 404-shells), the anonymous login 303, then the landed
 *  `requireOrgOwnership` posture — a signed-in non-owner 404-shells (the
 *  pages/org-teams.tsx header; upstream answers NotFound for every
 *  non-member). */
type ResolvedOrgTeamsRequest = Extract<ResolvedUiSession, { ok: true }> & { org: OrgRecord };

async function resolveOrgTeamsRequest(c: Context<{ Bindings: Env }>): Promise<ResolvedOrgTeamsRequest | { ok: false; response: Response }> {
  const resolved = await resolveUiSession(c);
  if (!resolved.ok) return resolved;
  const { url, ctx, viewer, respond } = resolved;
  const route = resolved.route;
  if (!("owner" in route)) return { ok: false, response: respond(await c.notFound()) }; // registration/parser drift guard
  const doer = viewer.kind === "user" ? { id: viewer.id, isAdmin: viewer.isAdmin } : { id: null, isAdmin: false };
  const query = url.search.startsWith("?") ? url.search.slice(1) : url.search;
  const org = await resolveOrgTeamsOrg(c.env.DB, route.owner, doer, url.pathname, query);
  if (org.kind === "redirect") {
    return { ok: false, response: respond(new Response(null, { status: 307, headers: { location: org.location } })) };
  }
  if (org.kind === "missing") return { ok: false, response: respond(c.html(renderNotFound(ctx), 404)) };
  if (viewer.kind === "anonymous") return { ok: false, response: respond(loginRedirect(url.pathname + url.search)) };
  if (!(await canManageOrgTeams(c.env.DB, org.org, viewer))) {
    return { ok: false, response: respond(c.html(renderNotFound(ctx), 404)) };
  }
  return { ...resolved, org: org.org };
}

/** GET /{org}/teams (pages/org-teams.tsx — the teams list; the landed
 *  orgListTeams read's owner arm). */
async function orgTeamsPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveOrgTeamsRequest(c);
  if (!resolved.ok) return resolved.response;
  const { url, ctx, respond } = resolved;
  if (resolved.route.family !== "org-teams") return respond(await c.notFound()); // drift guard
  const data = await loadOrgTeamsData(c.env.DB, resolved.org, url.searchParams);
  return respond(c.html(renderOrgTeamsPage(ctx, data), 200));
}

/** GET /{org}/teams/{id|name} (pages/org-teams.tsx — the detail slice: the
 *  members list + the repo-access list; an unknown or foreign-org carrier
 *  404-shells — id per getTeamById, name per the R19 case-folded lower_name
 *  lookup, loadOrgTeamDetailDataByName). */
async function orgTeamDetailPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveOrgTeamsRequest(c);
  if (!resolved.ok) return resolved.response;
  const { ctx, respond } = resolved;
  const route = resolved.route;
  if (route.family !== "org-team-detail") return respond(await c.notFound()); // drift guard
  const data =
    route.id !== undefined
      ? await loadOrgTeamDetailData(c.env.DB, resolved.org, route.id)
      : route.name !== undefined
        ? await loadOrgTeamDetailDataByName(c.env.DB, resolved.org, route.name)
        : null;
  if (data === null) return respond(c.html(renderNotFound(ctx), 404));
  return respond(c.html(renderOrgTeamDetailPage(ctx, data), 200));
}

/** GET /{org}/teams/new (pages/org-teams.tsx — the create form; the same
 *  gate as the list). */
async function orgTeamNewPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveOrgTeamsRequest(c);
  if (!resolved.ok) return resolved.response;
  const { ctx, respond } = resolved;
  if (resolved.route.family !== "org-team-new") return respond(await c.notFound()); // drift guard
  return respond(c.html(renderOrgTeamNewPage(ctx, { org: resolved.org, form: { name: "", permission: "read" }, error: null }), 200));
}

/**
 * POST /{org}/teams/new (upstream NewTeamPost, routers/web/org/teams.go:
 * 344-390 over the landed create arm): the §2.8 Origin guard, the shared
 * prologue, then `TeamsService.createTeam` — success 303s onto the created
 * team's detail slice (upstream redirects onto the team's page; the slice
 * keys on the id — the module header's route-shape note); the typed NewTeam
 * 422s re-render the form at 200 with the message and the submitted values
 * (the login failure convention).
 */
async function orgTeamNewSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveOrgTeamsRequest(c);
  if (!resolved.ok) return resolved.response;
  const { ctx, org, respond } = resolved;
  if (resolved.route.family !== "org-team-new") return respond(await c.notFound()); // drift guard
  const form = parseTeamNewForm(await readUrlEncodedForm(c.req.raw));
  const result = await createTeamFromForm(c.env.DB, org, form);
  if (result.outcome === "created") {
    return respond(new Response(null, { status: 303, headers: { location: `/${org.username}/teams/${result.team.id}` } }));
  }
  return respond(c.html(renderOrgTeamNewPage(ctx, { org, form, error: result.message }), 200));
}

// ---------------------------------------------------------------------------
// The census R06 org dashboard (pages/org-dashboard.tsx — upstream's
// /org/{org}/dashboard[/{team}] literals, web.go:982-985)
// ---------------------------------------------------------------------------

/**
 * GET /org/{org}/dashboard[/{team}] (pages/org-dashboard.tsx — the
 * member-only org dashboard; upstream `user.Dashboard` under
 * `OrgAssignment{RequireMember, RequireTeamMember}`). The ladder: the
 * session half, the drift guard, the org resolution (a renamed org 307s, a
 * miss 404-shells), then upstream's RequireMember — anonymous AND signed-in
 * non-members 404-shell (upstream's NotFound; the group is not reqSignIn'd,
 * so there is NO login redirect — the census's Open Issues #9 posture).
 * The {team} tail: the case-folded lower-name resolution (org.go:213-218;
 * a miss shells like upstream's teamExists arm) behind RequireTeamMember
 * (org.go:226-236 — owner/site-admin pass, a plain member needs the
 * team_members row).
 */
async function orgDashboardPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiSession(c);
  if (!resolved.ok) return resolved.response;
  const { url, ctx, viewer, respond } = resolved;
  const route = resolved.route;
  if (route.family !== "org-dashboard") return respond(await c.notFound()); // drift guard
  const doer = orgFamilyDoer(viewer);
  const org = await resolveOrgDashboardOrg(c.env.DB, route.owner, doer, url.pathname, orgFamilyQuery(url));
  if (org.kind === "redirect") {
    return respond(new Response(null, { status: 307, headers: { location: org.location } }));
  }
  if (org.kind === "missing") return respond(c.html(renderNotFound(ctx), 404));
  if (!(await isOrgDashboardMember(c.env.DB, org.org, viewer))) {
    return respond(c.html(renderNotFound(ctx), 404));
  }
  let team: TeamRecord | null = null;
  if (route.team !== undefined) {
    team = await resolveDashboardTeam(c.env.DB, org.org, route.team);
    if (team === null || !(await isOrgDashboardTeamMember(c.env.DB, org.org, team, viewer))) {
      return respond(c.html(renderNotFound(ctx), 404));
    }
  }
  const data = await loadOrgDashboardData(c.env.DB, org.org, viewer, url.origin, url.searchParams, team);
  const viewerName = viewer.kind === "user" ? viewer.username : "";
  return respond(c.html(renderOrgDashboardPage(ctx, data, viewerName), 200));
}

// ---------------------------------------------------------------------------
// The wave-14 org labels family (pages/org-labels.tsx — the brief's literal
// /{org}/labels page + upstream's /labels/{new,edit,delete} POST segments)
// ---------------------------------------------------------------------------

/**
 * GET /{org}/labels (pages/org-labels.tsx — the management list + create
 * form). The org-teams prologue is family-agnostic (session → org resolve →
 * the requireOrgOwnership gate) and serves unchanged: an anonymous viewer
 * 303s onto the login round-trip, a signed-in non-owner 404-shells (the
 * upstream page sits in the "require owner permission" org group), a renamed
 * org 307s onto the new name.
 */
async function orgLabelsPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveOrgTeamsRequest(c);
  if (!resolved.ok) return resolved.response;
  const { url, ctx, respond } = resolved;
  if (resolved.route.family !== "org-labels") return respond(await c.notFound()); // drift guard
  const data = await loadOrgLabelsData(c.env.DB, resolved.org, url.searchParams);
  return respond(c.html(renderOrgLabelsPage({ ctx, data, form: { title: "", color: NEW_LABEL_DEFAULT_COLOR }, error: null }), 200));
}

/**
 * POST /{org}/labels/new (upstream org.NewLabel over the landed create arm):
 * the §2.8 Origin guard, the shared prologue, then `normalizeLabelColor` +
 * `createOrgLabel` — success 303s back onto the list (upstream
 * JSONRedirect's target), the empty-title guard and the color 422 re-render
 * at 200 with the message and the kept submission (the login failure
 * convention).
 */
async function orgLabelNewSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveOrgTeamsRequest(c);
  if (!resolved.ok) return resolved.response;
  const { ctx, org, respond } = resolved;
  if (resolved.route.family !== "org-label-new") return respond(await c.notFound()); // drift guard
  const form = parseOrgLabelForm(await readUrlEncodedForm(c.req.raw));
  const result = await createOrgLabelFromForm(c.env.DB, org.id, form);
  if (result.outcome === "applied") {
    return respond(new Response(null, { status: 303, headers: { location: `/${org.username}/labels` } }));
  }
  const data = await loadOrgLabelsData(c.env.DB, org, new URLSearchParams());
  return respond(c.html(renderOrgLabelsPage({ ctx, data, form, error: result.message }), 200));
}

/**
 * POST /{org}/labels/edit (upstream org.UpdateLabel over the landed edit
 * arm's order — the org-scoped lookup before any color 422): success 303s
 * back onto the list; a missing/foreign id 404-shells (the landed PATCH
 * arm's plain "not found"); the failures re-render with the error banner
 * and the STORED row values (pages/org-labels.tsx's re-render note).
 */
async function orgLabelEditSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveOrgTeamsRequest(c);
  if (!resolved.ok) return resolved.response;
  const { ctx, org, respond } = resolved;
  if (resolved.route.family !== "org-label-edit") return respond(await c.notFound()); // drift guard
  const params = await readUrlEncodedForm(c.req.raw);
  const form = parseOrgLabelForm(params);
  const result = await editOrgLabelFromForm(c.env.DB, org.id, formLabelId(params.get("id")), form);
  if (result.outcome === "applied") {
    return respond(new Response(null, { status: 303, headers: { location: `/${org.username}/labels` } }));
  }
  if (result.outcome === "missing") return respond(c.html(renderNotFound(ctx), 404));
  const data = await loadOrgLabelsData(c.env.DB, org, new URLSearchParams());
  return respond(c.html(renderOrgLabelsPage({ ctx, data, form: { title: "", color: NEW_LABEL_DEFAULT_COLOR }, error: result.message }), 200));
}

/**
 * POST /{org}/labels/delete (upstream org.DeleteLabel over the landed
 * delete arm): the cascade delete when the org-scoped row exists, SUCCESS
 * either way (the arm's zero-row 204) — both arms 303 back onto the list.
 */
async function orgLabelDeleteSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveOrgTeamsRequest(c);
  if (!resolved.ok) return resolved.response;
  const { org, respond } = resolved;
  if (resolved.route.family !== "org-label-delete") return respond(await c.notFound()); // drift guard
  const params = await readUrlEncodedForm(c.req.raw);
  await deleteOrgLabelFromForm(c.env.DB, org.id, formLabelId(params.get("id")));
  return respond(new Response(null, { status: 303, headers: { location: `/${org.username}/labels` } }));
}

// ---------------------------------------------------------------------------
// The wave-49 org settings + team-edit family (pages/org-settings.tsx —
// upstream's require-owner /{org} group: web.go:1011's team edit/delete and
// web.go:1017-1092's /settings subtree)
// ---------------------------------------------------------------------------

/**
 * GET /{org}/settings (pages/org-settings.tsx — the options page: the
 * profile form, the avatar pair and the danger zone). The org-teams
 * prologue is family-agnostic and serves unchanged: anonymous 303s onto the
 * login round-trip, a signed-in non-owner 404-shells (upstream's
 * RequireOwner OrgAssignment NotFound), a renamed org 307s onto the new
 * name.
 */
async function orgSettingsPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveOrgTeamsRequest(c);
  if (!resolved.ok) return resolved.response;
  const { ctx, respond } = resolved;
  if (resolved.route.family !== "org-settings") return respond(await c.notFound()); // drift guard
  return respond(c.html(renderOrgSettingsPage(ctx, { org: resolved.org, error: null }), 200));
}

/**
 * POST /{org}/settings (upstream SettingsPost, routers/web/org/setting.go:61-99
 * over the landed orgEdit arm): the §2.8 Origin guard, the shared prologue,
 * then `editOrgProfile` — the form's exact fields (empty clears, the Go
 * empty-pointer semantics). Success 303s back onto the page (upstream's
 * redirect); no server-side validation arms exist to re-render (the
 * EditOrgOption binding note).
 */
async function orgSettingsSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveOrgTeamsRequest(c);
  if (!resolved.ok) return resolved.response;
  const { org, respond } = resolved;
  if (resolved.route.family !== "org-settings") return respond(await c.notFound()); // drift guard
  const form = parseOrgSettingsForm(await readUrlEncodedForm(c.req.raw));
  await applyOrgSettingsForm(c.env.DB, org, form);
  return respond(new Response(null, { status: 303, headers: { location: `/${org.username}/settings` } }));
}

/**
 * POST /{org}/settings/avatar (upstream SettingsAvatar over the landed
 * avatar store — the API arm's decode→process→store body): the §2.8 guard,
 * the prologue, the multipart parse, then `storeOrgAvatar`. Both arms
 * redirect back silently (upstream Flash.Error/Success + unconditional
 * redirect; no session-flash plumbing — the user-settings reduction).
 */
async function orgSettingsAvatarSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveOrgTeamsRequest(c);
  if (!resolved.ok) return resolved.response;
  const { org, respond } = resolved;
  if (resolved.route.family !== "org-settings-avatar") return respond(await c.notFound()); // drift guard
  const upload = await readOrgAvatarUpload(c.req.raw);
  if (upload.outcome === "applied") {
    await storeOrgAvatar(c.env.REPO_PACKS, c.env.DB, org, upload);
  }
  return respond(new Response(null, { status: 303, headers: { location: `/${org.username}/settings` } }));
}

/**
 * POST /{org}/settings/avatar/delete (upstream SettingsDeleteAvatar over the
 * landed deleteAvatar): the delete is a success no-op on a missing object
 * (the API arm's tolerance); the redirect is unconditional.
 */
async function orgSettingsAvatarDeleteSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveOrgTeamsRequest(c);
  if (!resolved.ok) return resolved.response;
  const { org, respond } = resolved;
  if (resolved.route.family !== "org-settings-avatar-delete") return respond(await c.notFound()); // drift guard
  await deleteOrgAvatar(c.env.REPO_PACKS, c.env.DB, org);
  return respond(new Response(null, { status: 303, headers: { location: `/${org.username}/settings` } }));
}

/**
 * POST /{org}/settings/rename (upstream SettingsRenamePost over the landed
 * renameOrg service): the §2.8 guard, the prologue, then the confirmation +
 * no-change guards and the name rules — the failures re-render the settings
 * page at 200 with the upstream banner text (upstream JSONError into the
 * modal form; the org-labels typed-422 convention), success 303s onto the
 * RENAMED org's settings page (upstream's JSONRedirect target).
 */
async function orgSettingsRenameSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveOrgTeamsRequest(c);
  if (!resolved.ok) return resolved.response;
  const { ctx, org, respond } = resolved;
  if (resolved.route.family !== "org-settings-rename") return respond(await c.notFound()); // drift guard
  const form = parseOrgRenameForm(await readUrlEncodedForm(c.req.raw));
  const result = await applyOrgRenameForm(c.env.DB, org, form);
  if (result.outcome === "applied") {
    return respond(new Response(null, { status: 303, headers: { location: `/${result.org.username}/settings` } }));
  }
  return respond(c.html(renderOrgSettingsPage(ctx, { org, error: result.message }), 200));
}

/**
 * POST /{org}/settings/delete (upstream SettingsDeleteOrgPost over the
 * landed orgDelete cascade): the §2.8 guard, the prologue, then the
 * confirmation guard and the still-owns-repos refusal — the failures
 * re-render at 200 with the banner (upstream JSONError); success 303s onto
 * the site root (upstream's JSONRedirect target — the org is gone).
 */
async function orgSettingsDeleteSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveOrgTeamsRequest(c);
  if (!resolved.ok) return resolved.response;
  const { ctx, org, respond } = resolved;
  if (resolved.route.family !== "org-settings-delete") return respond(await c.notFound()); // drift guard
  const form = parseOrgDeleteForm(await readUrlEncodedForm(c.req.raw));
  const result = await applyOrgDeleteForm(c.env.DB, org, form);
  if (result.outcome === "deleted") {
    return respond(new Response(null, { status: 303, headers: { location: `/` } }));
  }
  return respond(c.html(renderOrgSettingsPage(ctx, { org, error: result.message }), 200));
}

/**
 * POST /{org}/settings/visibility (upstream SettingsChangeVisibilityPost
 * over the landed orgEdit's `visibility` key): the §2.8 guard, the
 * prologue, then the write — the unchanged and out-of-enum values answer
 * upstream's redirect arms (nothing-has-been-changed / invalid_data), both
 * silent here (no flash plumbing); every arm 303s back onto the page.
 */
async function orgSettingsVisibilitySubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveOrgTeamsRequest(c);
  if (!resolved.ok) return resolved.response;
  const { org, respond } = resolved;
  if (resolved.route.family !== "org-settings-visibility") return respond(await c.notFound()); // drift guard
  const visibility = parseOrgVisibilityForm(await readUrlEncodedForm(c.req.raw));
  await applyOrgVisibilityForm(c.env.DB, org, visibility);
  return respond(new Response(null, { status: 303, headers: { location: `/${org.username}/settings` } }));
}

// ---------------------------------------------------------------------------
// The wave-53 org settings hooks tab (pages/org-settings-hooks.tsx —
// upstream's web.go:1033-1044 /hooks group: org.Webhooks + org.DeleteWebhook
// over the landed owner-scoped arms, and the shared WebHooksEdit /
// GiteaHooksEditPost org-scope shapes)
// ---------------------------------------------------------------------------

/**
 * GET /{org}/settings/hooks (pages/org-settings-hooks.tsx — the webhooks
 * list + add form over the landed `listOwnerHooks` arm). The org-teams
 * prologue is family-agnostic and serves unchanged: anonymous 303s onto the
 * login round-trip, a signed-in non-owner 404-shells (upstream's
 * RequireOwner OrgAssignment NotFound), a renamed org 307s onto the new name.
 */
async function orgHooksSettingsPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveOrgTeamsRequest(c);
  if (!resolved.ok) return resolved.response;
  const { ctx, respond } = resolved;
  if (resolved.route.family !== "org-settings-hooks") return respond(await c.notFound()); // drift guard
  const data = await loadOrgHooksSettings(c.env.DB, resolved.org);
  return respond(c.html(renderOrgHooksSettingsPage({ ctx, data, error: null }), 200));
}

/**
 * POST /{org}/settings/hooks (upstream's addWebhookAddRoutes reduced to the
 * single landed provider — pages/org-settings-hooks.tsx's header — over the
 * landed `createOwnerHook`, the orgCreateHook API arm's service): the §2.8
 * Origin guard, the shared prologue, then the write — the
 * checkCreateHookOption 422s re-render the list at 200 with the message and
 * the kept submission (the repo hooks-page convention), success 303s back
 * onto the list (upstream's redirect arm).
 */
async function orgHooksSettingsSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveOrgTeamsRequest(c);
  if (!resolved.ok) return resolved.response;
  const { ctx, org, respond } = resolved;
  if (resolved.route.family !== "org-settings-hooks") return respond(await c.notFound()); // drift guard
  const form = parseCreateHookForm(await readUrlEncodedForm(c.req.raw));
  const result = await createOrgHookFromForm(c.env.DB, org, form);
  if (result.outcome === "created") {
    return respond(new Response(null, { status: 303, headers: { location: `/${org.username}/settings/hooks` } }));
  }
  const data = await loadOrgHooksSettings(c.env.DB, org);
  data.form = { name: form.name, payloadUrl: form.payloadUrl, contentType: form.contentType };
  return respond(c.html(renderOrgHooksSettingsPage({ ctx, data, error: result.message }), 200));
}

/**
 * GET /{org}/settings/hooks/{id} (pages/org-settings-hooks.tsx — the edit
 * page over the landed `getOwnerHook` arm): the shared prologue, the drift
 * guard, then the org-scoped hook read — an unknown or foreign-org id
 * 404-shells (the landed DELETE arm's 404, existence stays hidden).
 */
async function orgHookDetailPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveOrgTeamsRequest(c);
  if (!resolved.ok) return resolved.response;
  const { ctx, respond } = resolved;
  const route = resolved.route;
  if (route.family !== "org-settings-hook-detail" || route.id === undefined) return respond(await c.notFound()); // drift guard
  const data = await loadOrgHookDetailData(c.env.DB, resolved.org, route.id);
  if (data === null) return respond(c.html(renderNotFound(ctx), 404));
  return respond(c.html(renderOrgHookDetailPage({ ctx, data, error: null }), 200));
}

/**
 * POST /{org}/settings/hooks/{id} — the edit write (upstream
 * GiteaHooksEditPost's org-scope shape over the landed PATCH arm's service —
 * `editRepoHook` is scope-agnostic by construction and the org API arm calls
 * the very same function, routes/hooks-scopes.ts:521): the §2.8 guard, the
 * shared prologue, the org-scoped hook read, then the form write — the 422
 * validations re-render at 200 with the message and the kept submission (the
 * repo hooks-page convention), success 303s back onto the page (upstream
 * editWebhook's redirect). The POST rides the page URL — upstream
 * type-prefixes it (`/gitea/{id}`); the repo page's divergence note.
 */
async function orgHookDetailSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveOrgTeamsRequest(c);
  if (!resolved.ok) return resolved.response;
  const { ctx, org, respond } = resolved;
  const route = resolved.route;
  if (route.family !== "org-settings-hook-detail" || route.id === undefined) return respond(await c.notFound()); // drift guard
  const hook = await getOwnerHook(c.env.DB, org.id, route.id);
  if (hook === null) return respond(c.html(renderNotFound(ctx), 404));
  const hookLink = `/${org.username}/settings/hooks/${hook.id}`;
  const form = parseHookEditForm(await readUrlEncodedForm(c.req.raw));
  const result = await editHookFromForm(c.env.DB, hook, form);
  if (result.outcome === "saved") {
    return respond(new Response(null, { status: 303, headers: { location: hookLink } }));
  }
  const data = await loadOrgHookDetailData(c.env.DB, org, hook.id);
  if (data === null) return respond(c.html(renderNotFound(ctx), 404));
  data.form = form;
  return respond(c.html(renderOrgHookDetailPage({ ctx, data, error: result.message }), 200));
}

/**
 * POST /{org}/settings/hooks/{id}/delete — upstream DeleteWebhook's org arm
 * (org/setting.go:175-187) over the landed `deleteOwnerHook` (the arm-scoped
 * tail — the repo hooks-page convention, the module header): success 303s
 * onto the hooks list (upstream JSONRedirect's target); a miss 404-shells
 * (the landed DELETE arm's 404 — existence stays hidden).
 */
async function orgHookDeleteSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveOrgTeamsRequest(c);
  if (!resolved.ok) return resolved.response;
  const { ctx, org, respond } = resolved;
  const route = resolved.route;
  if (route.family !== "org-settings-hook-delete" || route.id === undefined) return respond(await c.notFound()); // drift guard
  const deleted = await deleteOrgHook(c.env.DB, org, route.id);
  if (!deleted) return respond(c.html(renderNotFound(ctx), 404));
  return respond(new Response(null, { status: 303, headers: { location: `/${org.username}/settings/hooks` } }));
}

// ---------------------------------------------------------------------------
// Window-2b: the org blocked-users tab + the actions secrets/variables
// sub-tabs (the two-stage modules' handoff recipes — same prologue, drift
// guards, sameOriginGuard-first POSTs).
// ---------------------------------------------------------------------------

async function orgBlockedUsersPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveOrgTeamsRequest(c);
  if (!resolved.ok) return resolved.response;
  const { ctx, respond } = resolved;
  if (resolved.route.family !== "org-settings-blocked") return respond(await c.notFound()); // drift guard
  const data = await loadOrgBlockedUsers(c.env.DB, resolved.org);
  return respond(c.html(renderOrgBlockedUsersPage({ ctx, data, error: null }), 200));
}

async function orgBlockedUsersSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveOrgTeamsRequest(c);
  if (!resolved.ok) return resolved.response;
  const { ctx, org, viewer, respond } = resolved;
  if (resolved.route.family !== "org-settings-blocked") return respond(await c.notFound()); // drift guard
  if (viewer.kind !== "user") return respond(c.html(renderNotFound(ctx), 404)); // the prologue's silent-auth-failure convention
  const form = parseOrgBlockedForm(await readUrlEncodedForm(c.req.raw));
  const result = await applyOrgBlockedForm(c.env.DB, org, { id: viewer.id, isAdmin: viewer.isAdmin }, form);
  if (result.outcome === "applied") {
    return respond(new Response(null, { status: 303, headers: { location: `/${org.username}/settings/blocked_users` } }));
  }
  const data = await loadOrgBlockedUsers(c.env.DB, org);
  return respond(c.html(renderOrgBlockedUsersPage({ ctx, data, error: result.message }), 200));
}

async function orgActionsSecretsPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveOrgTeamsRequest(c);
  if (!resolved.ok) return resolved.response;
  const { ctx, respond } = resolved;
  if (resolved.route.family !== "org-actions-secrets") return respond(await c.notFound()); // drift guard
  const data = await loadOrgActionsSecretsPageData(c.env.DB, resolved.org);
  return respond(c.html(renderOrgActionsSecretsPage(ctx, data), 200));
}

async function orgActionsSecretsSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveOrgTeamsRequest(c);
  if (!resolved.ok) return resolved.response;
  const { ctx, org, respond } = resolved;
  if (resolved.route.family !== "org-actions-secrets") return respond(await c.notFound()); // drift guard
  const form = parseOrgActionsSecretForm(await readUrlEncodedForm(c.req.raw));
  const outcome = await applyOrgActionsSecretForm(c.env.DB, org.id, form);
  if (outcome.outcome === "saved") {
    return respond(new Response(null, { status: 303, headers: { location: `/${org.username}/settings/actions/secrets` } }));
  }
  const data = await loadOrgActionsSecretsPageData(c.env.DB, org);
  // Carried name/description only — plaintext never enters the DOM.
  data.form = { name: form.name, data: "", description: form.description };
  return respond(c.html(renderOrgActionsSecretsPage(ctx, data, outcome.message)));
}

async function orgActionsSecretsDelete(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveOrgTeamsRequest(c);
  if (!resolved.ok) return resolved.response;
  const { org, respond } = resolved;
  if (resolved.route.family !== "org-actions-secrets-delete") return respond(await c.notFound()); // drift guard
  const form = parseOrgActionsSecretDeleteForm(await readUrlEncodedForm(c.req.raw));
  await deleteOrgActionsSecret(c.env.DB, org.id, form);
  return respond(new Response(null, { status: 303, headers: { location: `/${org.username}/settings/actions/secrets` } }));
}

async function orgActionsVariablesPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveOrgTeamsRequest(c);
  if (!resolved.ok) return resolved.response;
  const { ctx, respond } = resolved;
  if (resolved.route.family !== "org-actions-variables") return respond(await c.notFound()); // drift guard
  const data = await loadOrgActionsVariablesPageData(c.env.DB, resolved.org);
  return respond(c.html(renderOrgActionsVariablesPage(ctx, data), 200));
}

async function orgActionsVariablesNew(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveOrgTeamsRequest(c);
  if (!resolved.ok) return resolved.response;
  const { ctx, org, respond } = resolved;
  if (resolved.route.family !== "org-actions-variables-new") return respond(await c.notFound()); // drift guard
  const form = parseOrgActionsVariableForm(await readUrlEncodedForm(c.req.raw));
  const outcome = await applyOrgActionsVariableCreate(c.env.DB, org.id, form);
  if (outcome.outcome === "saved") {
    return respond(new Response(null, { status: 303, headers: { location: `/${org.username}/settings/actions/variables` } }));
  }
  const data = await loadOrgActionsVariablesPageData(c.env.DB, org);
  if (outcome.outcome === "invalid") {
    data.form = { name: form.name, data: form.data, description: form.description };
    return respond(c.html(renderOrgActionsVariablesPage(ctx, data, outcome.message)));
  }
  return respond(c.html(renderNotFound(ctx), 404));
}

async function orgActionsVariablesEdit(c: Context<{ Bindings: Env }>, variableId: number): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveOrgTeamsRequest(c);
  if (!resolved.ok) return resolved.response;
  const { ctx, org, respond } = resolved;
  if (resolved.route.family !== "org-actions-variables-edit") return respond(await c.notFound()); // drift guard
  const form = parseOrgActionsVariableForm(await readUrlEncodedForm(c.req.raw));
  const outcome = await applyOrgActionsVariableUpdate(c.env.DB, org.id, variableId, form);
  if (outcome.outcome === "saved") {
    return respond(new Response(null, { status: 303, headers: { location: `/${org.username}/settings/actions/variables` } }));
  }
  if (outcome.outcome === "missing") {
    // Upstream's findActionsVariable miss → ctx.NotFound(nil) — a genuine
    // 404 (the module handoff's fidelity call).
    return respond(c.html(renderNotFound(ctx), 404));
  }
  const data = await loadOrgActionsVariablesPageData(c.env.DB, org);
  data.form = { name: form.name, data: form.data, description: form.description };
  return respond(c.html(renderOrgActionsVariablesPage(ctx, data, outcome.message)));
}

async function orgActionsVariablesDelete(c: Context<{ Bindings: Env }>, variableId: number): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveOrgTeamsRequest(c);
  if (!resolved.ok) return resolved.response;
  const { ctx, org, respond } = resolved;
  if (resolved.route.family !== "org-actions-variables-delete") return respond(await c.notFound()); // drift guard
  const outcome = await deleteOrgActionsVariable(c.env.DB, org.id, variableId);
  if (outcome === "missing") return respond(c.html(renderNotFound(ctx), 404));
  return respond(new Response(null, { status: 303, headers: { location: `/${org.username}/settings/actions/variables` } }));
}

// ---------------------------------------------------------------------------
// The census C7 org arm: the org settings Actions RUNNERS sub-tab (pages/
// org-settings-actions-runners.tsx — upstream web.go:1058's
// addSettingsRunnersRoutes inside the org /actions group; the require-owner
// prologue IS the gate — the org arm of MustEnableActions checks only the
// instance-level flags at this scope, both compile-time TRUE in the landed
// posture, the module header — sameOriginGuard-first POSTs).
// ---------------------------------------------------------------------------

/** GET /{org}/settings/actions/runners (shared_actions.Runners' org arm,
 * runners.go:102-155) through the require-owner prologue. */
async function orgActionsRunnersPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveOrgTeamsRequest(c);
  if (!resolved.ok) return resolved.response;
  const { ctx, org, respond } = resolved;
  if (resolved.route.family !== "org-actions-runners") return respond(await c.notFound()); // drift guard
  const data = await loadOrgActionsRunnersPageData(c.env.DB, org, new URL(c.req.raw.url).searchParams);
  return respond(c.html(renderOrgActionsRunnersPage(ctx, data), 200));
}

/** POST /{org}/settings/actions/runners/reset_registration_token
 * (ResetRunnerRegistrationToken, runners.go:275-290): NewRunnerToken at the
 * org scope, then the plain 303 back onto the list URL (upstream's
 * JSONRedirect — the no-session-flash 303 reduction, the repo twin's
 * convention). */
async function orgActionsRunnersTokenReset(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveOrgTeamsRequest(c);
  if (!resolved.ok) return resolved.response;
  const { org, respond } = resolved;
  if (resolved.route.family !== "org-actions-runners-token-reset") return respond(await c.notFound()); // drift guard
  await resetOrgActionsRunnerToken(c.env.DB, org.id);
  return respond(new Response(null, { status: 303, headers: { location: `/${org.username}/settings/actions/runners` } }));
}

/** GET /{org}/settings/actions/runners/{id} (RunnersEdit, runners.go:158-216):
 * the scope-guarded runner plus its recent tasks; a foreign/global/stale id
 * answers the 404 shell (upstream's findActionsRunner org arm +
 * EditableInContext NotFound arms — both fold into the module's scope
 * predicate). */
async function orgActionsRunnerEditPage(c: Context<{ Bindings: Env }>, runnerId: number): Promise<Response> {
  const resolved = await resolveOrgTeamsRequest(c);
  if (!resolved.ok) return resolved.response;
  const { ctx, org, respond } = resolved;
  if (resolved.route.family !== "org-actions-runners-edit") return respond(await c.notFound()); // drift guard
  const data = await loadOrgActionsRunnerEditPageData(c.env.DB, org, runnerId, new URL(c.req.raw.url).searchParams);
  if (data === null) return respond(c.html(renderNotFound(ctx), 404));
  return respond(c.html(renderOrgActionsRunnerEditPage(ctx, data), 200));
}

/** POST /{org}/settings/actions/runners/{id} (RunnersEditPost,
 * runners.go:219-254): the description overwrite; "updated" 303s back onto
 * the LIST URL (upstream's Redirect(redirectTo) with the flash line not
 * rendered — the no-session-flash reduction); "missing" is the 404 shell. */
async function orgActionsRunnerEditSubmit(c: Context<{ Bindings: Env }>, runnerId: number): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveOrgTeamsRequest(c);
  if (!resolved.ok) return resolved.response;
  const { ctx, org, respond } = resolved;
  if (resolved.route.family !== "org-actions-runners-edit") return respond(await c.notFound()); // drift guard
  const form = parseOrgActionsRunnerDescriptionForm(await readUrlEncodedForm(c.req.raw));
  const outcome = await updateOrgActionsRunnerDescription(c.env.DB, org.id, runnerId, form.description);
  if (outcome === "missing") return respond(c.html(renderNotFound(ctx), 404));
  return respond(new Response(null, { status: 303, headers: { location: `/${org.username}/settings/actions/runners` } }));
}

/** POST /{org}/settings/actions/runners/{id}/update-runner
 * (RunnerUpdatePost, runners.go:328-369): the required `disabled` flip —
 * an absent param answers upstream's exact 400 ("missing 'disabled'
 * parameter"); "updated" 303s back onto the EDIT page (upstream's
 * JSONRedirect("") stays-on-page arm, the no-JS reduction); "missing" is
 * the 404 shell. */
async function orgActionsRunnerUpdate(c: Context<{ Bindings: Env }>, runnerId: number): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveOrgTeamsRequest(c);
  if (!resolved.ok) return resolved.response;
  const { ctx, org, respond } = resolved;
  if (resolved.route.family !== "org-actions-runners-update") return respond(await c.notFound()); // drift guard
  const form = parseOrgActionsRunnerDisabledForm(await readUrlEncodedForm(c.req.raw));
  if (form.disabled === null) {
    return respond(new Response("missing 'disabled' parameter\n", { status: 400, headers: { "content-type": "text/plain;charset=utf-8", "x-content-type-options": "nosniff" } }));
  }
  const outcome = await setOrgActionsRunnerDisabled(c.env.DB, org.id, runnerId, form.disabled);
  if (outcome === "missing") return respond(c.html(renderNotFound(ctx), 404));
  return respond(new Response(null, { status: 303, headers: { location: `/${org.username}/settings/actions/runners/${runnerId}` } }));
}

/** POST /{org}/settings/actions/runners/{id}/delete
 * (RunnerDeletePost, runners.go:292-326): the scope-guarded hard delete —
 * "deleted" 303s onto the list URL; "missing" is the 404 shell (upstream's
 * findActionsRunner NotFound arm deletes nothing). */
async function orgActionsRunnerDelete(c: Context<{ Bindings: Env }>, runnerId: number): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveOrgTeamsRequest(c);
  if (!resolved.ok) return resolved.response;
  const { ctx, org, respond } = resolved;
  if (resolved.route.family !== "org-actions-runners-delete") return respond(await c.notFound()); // drift guard
  const outcome = await deleteOrgActionsRunner(c.env.DB, org.id, runnerId);
  if (outcome === "missing") return respond(c.html(renderNotFound(ctx), 404));
  return respond(new Response(null, { status: 303, headers: { location: `/${org.username}/settings/actions/runners` } }));
}

// ---------------------------------------------------------------------------
// The census R20 (a) arm: the org settings applications tab (pages/
// org-settings-applications.tsx — upstream web.go:1027-1037's /applications
// group; the org-OWNED oauth2 applications over the landed service's
// uid-parameterized arms keyed on the org's id). Same prologue, drift
// guards, sameOriginGuard-first POSTs as the whole /settings family.
// ---------------------------------------------------------------------------

/**
 * GET /{org}/settings/applications (pages/org-settings-applications.tsx —
 * upstream org.Applications, setting_oauth2.go:34-54, over the landed
 * listOAuth2Applications read keyed uid=org.id): the shared prologue, the
 * drift guard, then the load → render at 200.
 */
async function orgApplicationsPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveOrgTeamsRequest(c);
  if (!resolved.ok) return resolved.response;
  const { ctx, respond } = resolved;
  if (resolved.route.family !== "org-settings-applications") return respond(await c.notFound()); // drift guard
  const data = await loadOrgSettingsApplications(c.env.DB, resolved.org);
  return respond(c.html(renderOrgApplicationsPage({ ctx, data, error: null }), 200));
}

/**
 * POST /{org}/settings/applications/oauth2 — the create (upstream
 * OAuthApplicationsPost → AddApp's write half, oauth2_common.go:56-88): the
 * §2.8 guard, the shared prologue, the drift guard, then the form write.
 * Upstream answers success by rendering the EDIT page with the once-only
 * secret; with no landed edit page the honest no-JS analog is the FULL LIST
 * re-rendered at 200 carrying the once-only secret (the admin applications
 * page's exact reduction — the module header). An invalid form re-renders
 * at 200 with the banner + the kept submission (the org-team-new
 * RenderWithErr arm; upstream flashes and redirects to the list).
 */
async function orgApplicationsCreateSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveOrgTeamsRequest(c);
  if (!resolved.ok) return resolved.response;
  const { ctx, org, respond } = resolved;
  if (resolved.route.family !== "org-settings-applications-create") return respond(await c.notFound()); // drift guard
  const form = parseOrgApplicationCreateForm(await readUrlEncodedForm(c.req.raw));
  const result = await applyOrgApplicationCreate(c.env.DB, org, form);
  if (result.outcome === "created") {
    const data = await loadOrgSettingsApplications(c.env.DB, org);
    data.newClientSecret = result.secret;
    data.newClientId = result.row.clientId;
    return respond(c.html(renderOrgApplicationsPage({ ctx, data, error: null }), 200));
  }
  const data = await loadOrgSettingsApplications(c.env.DB, org);
  data.form = form;
  return respond(c.html(renderOrgApplicationsPage({ ctx, data, error: result.message }), 200));
}

/**
 * POST /{org}/settings/applications/oauth2/{id}/delete — the delete
 * (upstream DeleteApp's write half, oauth2_common.go:177-193, over the
 * landed (id, uid=org.id) delete): success 303s onto the list (upstream
 * JSONRedirect's target); a miss 404-shells (the org hooks-page delete
 * convention and the admin page's identical posture — upstream
 * ServerErrors a miss instead, the module header's documented divergence;
 * existence stays hidden either way).
 */
async function orgApplicationsDeleteSubmit(c: Context<{ Bindings: Env }>, id: number): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveOrgTeamsRequest(c);
  if (!resolved.ok) return resolved.response;
  const { ctx, org, respond } = resolved;
  if (resolved.route.family !== "org-settings-applications-delete") return respond(await c.notFound()); // drift guard
  const deleted = await deleteOrgApplication(c.env.DB, org, id);
  if (!deleted) return respond(c.html(renderNotFound(ctx), 404));
  return respond(new Response(null, { status: 303, headers: { location: `/${org.username}/settings/applications` } }));
}

/**
 * GET /{org}/settings/audit_logs (pages/settings-audit-logs.tsx — the R20
 * `+audit_logs` arm / the census R13 org mount; upstream web.go:1069's
 * `m.Get("/audit_logs", org_setting.ViewAuditLogs)` over the SAME shared
 * audit renderer as the repo arm): the org settings family's
 * resolveOrgTeamsRequest prologue (the require-owner gate — anonymous 303s
 * onto the login round-trip, a member non-owner 404-shells, upstream's
 * RequireOwner OrgAssignment NotFound), then the shared load → render at
 * 200. The scope pair keys the M4 instrumentation's encoding: scope_type
 * "organization" + scope_id String(org.id), the decimal users.id string the
 * org-create emit carried (services/orgs/orgs.ts:473, the cast(id as text)
 * subquery).
 */
async function orgAuditLogsPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveOrgTeamsRequest(c);
  if (!resolved.ok) return resolved.response;
  const { url, ctx, org, respond } = resolved;
  if (resolved.route.family !== "org-settings-audit-logs") return respond(await c.notFound()); // drift guard
  const data = await loadSettingsAuditLogs(c.env.DB, { type: "organization", id: String(org.id) }, url.searchParams);
  return respond(c.html(renderOrgSettingsAuditLogsPage({ ctx, org, data }), 200));
}

// ---------------------------------------------------------------------------
// Window-2c: the admin pages (pages/admin-dashboard.tsx +
// pages/admin-monitor.tsx — upstream's SignInRequired+AdminRequired gate,
// web.go:779: anonymous 303s onto the login round-trip, a signed-in
// non-admin 404-shells (upstream's NotFound posture for hidden admin
// surfaces).
// ---------------------------------------------------------------------------

/** The shared admin prologue: session → gates, answering {ctx, respond}
 *  or a terminal Response. */
async function adminPagePrologue(c: Context<{ Bindings: Env }>): Promise<
  { ok: true; ctx: UiContext; respond: (r: Response, status?: number) => Response } | { ok: false; response: Response }
> {
  const resolved = await resolveUiSession(c);
  if (!resolved.ok) return { ok: false, response: resolved.response };
  const { url, ctx, viewer, respond } = resolved;
  if (viewer.kind === "anonymous") return { ok: false, response: respond(loginRedirect(url.pathname + url.search)) };
  if (!viewer.isAdmin) return { ok: false, response: respond(c.html(renderNotFound(ctx), 404)) };
  return { ok: true, ctx, respond };
}

async function adminDashboardPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const p = await adminPagePrologue(c);
  if (!p.ok) return p.response;
  const data = await loadAdminDashboardData(routeNow());
  return p.respond(c.html(renderAdminDashboardPage({ ctx: p.ctx, data, flash: null })));
}

async function adminDashboardSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const p = await adminPagePrologue(c);
  if (!p.ok) return p.response;
  const form = parseAdminDashboardForm(await readUrlEncodedForm(c.req.raw));
  const result = await applyAdminDashboardForm(c.env, form);
  // Upstream redirects; with no flash queue the module's recipe re-renders
  // fresh at 200 with the flash (the handoff's documented reduction).
  const data = await loadAdminDashboardData(routeNow());
  const flash = { kind: result.outcome === "applied" ? "positive" as const : "negative" as const, text: result.message };
  return p.respond(c.html(renderAdminDashboardPage({ ctx: p.ctx, data, flash })));
}

async function adminMonitorPage(c: Context<{ Bindings: Env }>, page: AdminMonitorPage): Promise<Response> {
  const p = await adminPagePrologue(c);
  if (!p.ok) return p.response;
  switch (page) {
    case "stats": {
      const data = await loadAdminMonitorStats(c.env.DB);
      return p.respond(c.html(renderAdminMonitorStatsPage({ ctx: p.ctx, data })));
    }
    case "cron": {
      const data = { entries: loadAdminMonitorCron(routeNow()).entries };
      return p.respond(c.html(renderAdminMonitorCronPage({ ctx: p.ctx, data, flash: null })));
    }
    case "queue": {
      const data = await loadAdminMonitorQueues(c.env.DB);
      return p.respond(c.html(renderAdminMonitorQueuePage({ ctx: p.ctx, data })));
    }
    case "trace":
      return p.respond(c.html(renderAdminMonitorTracePage({ ctx: p.ctx })));
  }
}

async function adminMonitorCronSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const p = await adminPagePrologue(c);
  if (!p.ok) return p.response;
  const form = parseAdminMonitorCronForm(await readUrlEncodedForm(c.req.raw));
  const result = await applyAdminMonitorCronForm(c.env, form);
  const data = { entries: loadAdminMonitorCron(routeNow()).entries };
  const flash = { kind: result.outcome === "applied" ? "positive" as const : "negative" as const, text: result.message };
  return p.respond(c.html(renderAdminMonitorCronPage({ ctx: p.ctx, data, flash })));
}

// --- the admin listing pages (pages/admin-users.tsx / admin-orgs.tsx /
// admin-repos.tsx — upstream's /-/admin/users, /-/admin/orgs, /-/admin/repos;
// each rides the shared adminPagePrologue) -----------------------------------

/** GET /-/admin/users: the prologue → the paged users listing. */
async function adminUsersPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const p = await adminPagePrologue(c);
  if (!p.ok) return p.response;
  const data = await loadAdminUsersData(c.env.DB, new URL(c.req.raw.url).searchParams);
  return p.respond(c.html(renderAdminUsersPage(p.ctx, data)));
}

/** GET /-/admin/orgs: the prologue → the paged orgs listing. */
async function adminOrgsPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const p = await adminPagePrologue(c);
  if (!p.ok) return p.response;
  const data = await loadAdminOrgsData(c.env.DB, new URL(c.req.raw.url).searchParams);
  return p.respond(c.html(renderAdminOrgsPage(p.ctx, data)));
}

/** GET /-/admin/repos: the prologue → the paged repos listing (the loader
 *  takes the VIEWER — its visibility arm is doer-shaped, not admin-only). */
async function adminReposPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const p = await adminPagePrologue(c);
  if (!p.ok) return p.response;
  const data = await loadAdminReposData(c.env.DB, p.ctx.viewer, new URL(c.req.raw.url).searchParams);
  return p.respond(c.html(renderAdminReposPage(p.ctx, data)));
}

/** GET /-/admin/packages (pages/admin-packages.tsx — upstream web.go:852-858's
 *  /packages group; the group's `packagesEnabled` qualifier rides the
 *  strict-polarity PACKAGES_ENABLED var through ctx.packagesEnabled, the
 *  R04 prologue's 404-shell arm verbatim): the prologue → the paged packages
 *  listing. The group's delete/cleanup POSTs stay UNCLAIMED — unlanded
 *  writes (the module's dead-link note), the engine's 404, the admin-repos
 *  delete-tail posture. */
async function adminPackagesPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const p = await adminPagePrologue(c);
  if (!p.ok) return p.response;
  if (p.ctx.packagesEnabled === false) return p.respond(c.html(renderNotFound(p.ctx), 404));
  const data = await loadAdminPackagesData(c.env.DB, new URL(c.req.raw.url).searchParams);
  return p.respond(c.html(renderAdminPackagesPage(p.ctx, data)));
}

// --- the census R18 (a) arms (pages/admin-emails.tsx / admin-hooks.tsx /
// admin-badges.tsx / admin-applications.tsx — upstream's /-/admin emails,
// hooks, badges, applications groups; each rides the shared
// adminPagePrologue; the writes add the §2.8 sameOriginGuard) --------------

/** GET /-/admin/emails (pages/admin-emails.tsx): the prologue → the union
 *  listing (the loader takes the doer id — the CanChange formula's input,
 *  collapsed in this store per the module header). */
async function adminEmailsPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const p = await adminPagePrologue(c);
  if (!p.ok) return p.response;
  const viewer = p.ctx.viewer;
  const doerId = viewer.kind === "user" ? viewer.id : 0;
  const data = await loadAdminEmailsData(c.env.DB, doerId, new URL(c.req.raw.url).searchParams);
  return p.respond(c.html(renderAdminEmailsPage(p.ctx, data)));
}

/** The emails activate/delete POSTs' shared redirect builder — upstream's
 *  redirect-with-preserved-query arm (emails.go:126-141): q + sort (when
 *  not the default) + is_primary + is_activated. */
function adminEmailsRedirect(search: URLSearchParams): string {
  const params = parseAdminEmailsListParams(search);
  const next = new URLSearchParams();
  if (params.keyword !== "") next.set("q", params.keyword);
  if (params.sort !== "email") next.set("sort", params.sort);
  if (params.isPrimary !== null) next.set("is_primary", params.isPrimary);
  if (params.isActivated !== null) next.set("is_activated", params.isActivated);
  const qs = next.toString();
  return qs === "" ? "/-/admin/emails" : `/-/admin/emails?${qs}`;
}

/**
 * POST /-/admin/emails/activate (pages/admin-emails.tsx — upstream
 * ActivateEmail, emails.go:101-153): the §2.8 guard + the prologue, the
 * four-field bind (malformed → the handler's 400), then the write — every
 * outcome 303s back onto the list with the preserved query (the module's
 * no-flash reduction; the flash arms have no renderable analog).
 */
async function adminEmailsActivate(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const p = await adminPagePrologue(c);
  if (!p.ok) return p.response;
  const form = parseAdminEmailActivateForm(await readUrlEncodedForm(c.req.raw));
  if (!adminEmailActivateFormValid(form)) {
    return p.respond(new Response("bad request", { status: 400 }));
  }
  await applyAdminEmailActivate(c.env.DB, form);
  return p.respond(
    new Response(null, {
      status: 303,
      headers: { location: adminEmailsRedirect(new URL(c.req.raw.url).searchParams) },
    }),
  );
}

/**
 * POST /-/admin/emails/delete (upstream DeleteEmail, emails.go:155-187):
 * the same ladder; the lookup misses 303 silently (the stale-form posture —
 * the module header's note on upstream's ServerError arms).
 */
async function adminEmailsDelete(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const p = await adminPagePrologue(c);
  if (!p.ok) return p.response;
  const form = parseAdminEmailDeleteForm(await readUrlEncodedForm(c.req.raw));
  await applyAdminEmailDelete(c.env.DB, form);
  return p.respond(
    new Response(null, {
      status: 303,
      headers: { location: adminEmailsRedirect(new URL(c.req.raw.url).searchParams) },
    }),
  );
}

/** GET /-/admin/hooks (pages/admin-hooks.tsx): the prologue → the two-list
 *  read (system first, then default — the template's render order). */
async function adminHooksPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const p = await adminPagePrologue(c);
  if (!p.ok) return p.response;
  const data = await loadAdminHooksData(c.env.DB);
  return p.respond(c.html(renderAdminHooksPage(p.ctx, data)));
}

/** POST /-/admin/hooks/delete (upstream DeleteDefaultOrSystemWebhook): the
 *  id into the landed global delete; every outcome 303s back onto the list
 *  (the flash texts do not render — the module's no-flash note; an unknown
 *  id is the silent stale-form arm). */
async function adminHooksDelete(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const p = await adminPagePrologue(c);
  if (!p.ok) return p.response;
  const form = await readUrlEncodedForm(c.req.raw);
  const id = Number.parseInt(form.get("id") ?? "0", 10) || 0;
  await applyAdminHookDelete(c.env.DB, id);
  return p.respond(new Response(null, { status: 303, headers: { location: "/-/admin/hooks" } }));
}

/** GET /-/admin/badges (pages/admin-badges.tsx): the prologue → the
 *  catalog listing. */
async function adminBadgesPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const p = await adminPagePrologue(c);
  if (!p.ok) return p.response;
  const data = await loadAdminBadgesData(c.env.DB, new URL(c.req.raw.url).searchParams);
  return p.respond(c.html(renderAdminBadgesPage(p.ctx, data)));
}

/**
 * GET /-/admin/badges/new (upstream NewBadge): the empty create form. POST
 * (NewBadgePost) re-renders with the error on the invalid/taken arms (the
 * module's re-render reduction) and 303s onto the new badge's view page on
 * success (upstream's JSONRedirect target, badges.go:80).
 */
async function adminBadgeNewPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const p = await adminPagePrologue(c);
  if (!p.ok) return p.response;
  return p.respond(
    c.html(renderAdminBadgeNewPage(p.ctx, { form: { slug: "", description: "", imageUrl: "" }, error: null })),
  );
}

async function adminBadgeNewSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const p = await adminPagePrologue(c);
  if (!p.ok) return p.response;
  const form = parseAdminBadgeForm(await readUrlEncodedForm(c.req.raw));
  const outcome = await createBadgeFromForm(c.env.DB, form);
  if (outcome === "created") {
    return p.respond(
      new Response(null, { status: 303, headers: { location: `/-/admin/badges/slug/${encodeURIComponent(form.slug)}` } }),
    );
  }
  const error =
    outcome === "slug-taken" ? adminBadgesLocale.slug_been_taken : adminBadgesLocale.required_field;
  return p.respond(c.html(renderAdminBadgeNewPage(p.ctx, { form, error })));
}

/** GET /-/admin/badges/slug/{slug} (upstream ViewBadge): the badge info +
 *  the users preview (page 1); an unknown slug 303s back to the list
 *  (prepareBadgeInfo's redirect arm, badges.go:84-92 — upstream's own
 *  NotFound reduction for the miss). */
async function adminBadgeViewPage(c: Context<{ Bindings: Env }>, badgeSlug: string): Promise<Response> {
  const p = await adminPagePrologue(c);
  if (!p.ok) return p.response;
  const badge = await getBadgeBySlug(c.env.DB, badgeSlug);
  if (badge === null) {
    return p.respond(new Response(null, { status: 303, headers: { location: "/-/admin/badges" } }));
  }
  const usersPage = await getBadgeUsersPage(c.env.DB, badgeSlug, 1);
  return p.respond(
    c.html(
      renderAdminBadgeViewPage(p.ctx, {
        badge,
        usersTotal: usersPage.total,
        usersPreview: usersPage.items.map((user) => ({ id: user.id, username: user.username })),
      }),
    ),
  );
}

/**
 * GET+POST /-/admin/badges/slug/{slug}/edit (upstream EditBadge /
 * EditBadgePost): the badge-scoped edit form; the POST re-renders with the
 * error on the invalid arm (the module's reduction) and 303s back onto the
 * view page on success (upstream's JSONRedirect target, badges.go:128). An
 * unknown slug 303s to the list (prepareBadgeInfo's arm).
 */
async function adminBadgeEditPage(c: Context<{ Bindings: Env }>, badgeSlug: string): Promise<Response> {
  const p = await adminPagePrologue(c);
  if (!p.ok) return p.response;
  const badge = await getBadgeBySlug(c.env.DB, badgeSlug);
  if (badge === null) {
    return p.respond(new Response(null, { status: 303, headers: { location: "/-/admin/badges" } }));
  }
  const data: AdminBadgeEditData = {
    badge,
    form: { description: badge.description ?? "", imageUrl: badge.imageUrl ?? "" },
    error: null,
  };
  return p.respond(c.html(renderAdminBadgeEditPage(p.ctx, data)));
}

async function adminBadgeEditSubmit(c: Context<{ Bindings: Env }>, badgeSlug: string): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const p = await adminPagePrologue(c);
  if (!p.ok) return p.response;
  const badge = await getBadgeBySlug(c.env.DB, badgeSlug);
  if (badge === null) {
    return p.respond(new Response(null, { status: 303, headers: { location: "/-/admin/badges" } }));
  }
  const form = parseAdminBadgeForm(await readUrlEncodedForm(c.req.raw));
  const outcome = await updateBadgeFromForm(c.env.DB, badgeSlug, {
    description: form.description,
    imageUrl: form.imageUrl,
  });
  if (outcome === "updated") {
    return p.respond(new Response(null, { status: 303, headers: { location: `/-/admin/badges/slug/${encodeURIComponent(badgeSlug)}` } }));
  }
  const data: AdminBadgeEditData = {
    badge,
    form: { description: form.description, imageUrl: form.imageUrl },
    error: adminBadgesLocale.required_field,
  };
  return p.respond(c.html(renderAdminBadgeEditPage(p.ctx, data)));
}

/** POST /-/admin/badges/slug/{slug}/delete (upstream DeleteBadge): the
 *  edges-then-badge delete; every outcome 303s back onto the list
 *  (badges.go:143's redirect; the flash text does not render). */
async function adminBadgeDeleteSubmit(c: Context<{ Bindings: Env }>, badgeSlug: string): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const p = await adminPagePrologue(c);
  if (!p.ok) return p.response;
  await deleteBadgeBySlug(c.env.DB, badgeSlug);
  return p.respond(new Response(null, { status: 303, headers: { location: "/-/admin/badges" } }));
}

/**
 * GET+POST /-/admin/badges/slug/{slug}/users + POST .../users/delete
 * (upstream BadgeUsers / BadgeUsersPost / DeleteBadgeUser): the paged user
 * list, the add-by-name form (the error arms re-render with the upstream
 * message lines — the one write whose errors are user-actionable), and the
 * remove form. An unknown slug 303s to the list (the prepareBadgeInfo arm).
 */
async function adminBadgeUsersPage(c: Context<{ Bindings: Env }>, badgeSlug: string, error: string | null, submittedUser: string): Promise<Response> {
  const p = await adminPagePrologue(c);
  if (!p.ok) return p.response;
  const badge = await getBadgeBySlug(c.env.DB, badgeSlug);
  if (badge === null) {
    return p.respond(new Response(null, { status: 303, headers: { location: "/-/admin/badges" } }));
  }
  const search = new URL(c.req.raw.url).searchParams;
  const page = parsePageNumber(search.get("page"));
  const usersPage = await getBadgeUsersPage(c.env.DB, badgeSlug, page);
  const query = new URLSearchParams();
  const data: AdminBadgeUsersData = {
    badge,
    items: usersPage.items.map((user) => ({ id: user.id, username: user.username, fullName: user.fullName })),
    total: usersPage.total,
    more: usersPage.more,
    page,
    query,
    error,
    submittedUser,
  };
  return p.respond(c.html(renderAdminBadgeUsersPage(p.ctx, data)));
}

async function adminBadgeUsersAdd(c: Context<{ Bindings: Env }>, badgeSlug: string): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const p = await adminPagePrologue(c);
  if (!p.ok) return p.response;
  const form = await readUrlEncodedForm(c.req.raw);
  const rawName = form.get("user") ?? "";
  const outcome = await addBadgeUserByName(c.env.DB, badgeSlug, rawName);
  const error =
    outcome === "user-missing"
      ? adminBadgesLocale.user_not_exist
      : outcome === "badge-missing"
        ? adminBadgesLocale.badge_not_found
        : outcome === "already-has"
          ? adminBadgesLocale.user_already_has
          : null;
  // Upstream redirects back onto the users page with the flash; the re-render
  // carries the message inline (the module's reduction note).
  return adminBadgeUsersPage(c, badgeSlug, error, outcome === "added" ? "" : rawName);
}

async function adminBadgeUsersDelete(c: Context<{ Bindings: Env }>, badgeSlug: string): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const p = await adminPagePrologue(c);
  if (!p.ok) return p.response;
  const form = await readUrlEncodedForm(c.req.raw);
  const id = Number.parseInt(form.get("id") ?? "0", 10) || 0;
  await removeBadgeUser(c.env.DB, badgeSlug, id);
  return p.respond(
    new Response(null, { status: 303, headers: { location: `/-/admin/badges/slug/${encodeURIComponent(badgeSlug)}/users` } }),
  );
}

/** GET /-/admin/applications (pages/admin-applications.tsx): the prologue →
 *  the uid=0 instance-wide list. */
async function adminApplicationsPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const p = await adminPagePrologue(c);
  if (!p.ok) return p.response;
  const data = await loadAdminApplicationsData(c.env.DB);
  return p.respond(c.html(renderAdminApplicationsPage(p.ctx, data)));
}

/**
 * POST /-/admin/applications/oauth2 (upstream ApplicationsPost → AddApp):
 * the §2.8 guard + the prologue, the textarea form (redirect URIs
 * one-per-line), then the landed create — the invalid arms re-render the
 * full page with the error + the submitted values, the created arm
 * re-renders with the once-only secret (the module's reduction notes).
 */
async function adminApplicationCreate(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const p = await adminPagePrologue(c);
  if (!p.ok) return p.response;
  const form = parseAdminApplicationCreateForm(await readUrlEncodedForm(c.req.raw));
  const outcome = await applyAdminApplicationCreate(c.env.DB, form);
  return p.respond(c.html(renderAdminApplicationsPage(p.ctx, outcome.data)));
}

/** POST /-/admin/applications/oauth2/{id}/delete (upstream DeleteApp): the
 *  (id, uid=0) delete — the miss 404-shells (upstream NotFound on the same
 *  arm), the hit 303s back onto the list. */
async function adminApplicationDelete(c: Context<{ Bindings: Env }>, applicationId: number): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const p = await adminPagePrologue(c);
  if (!p.ok) return p.response;
  if (!(await applyAdminApplicationDelete(c.env.DB, applicationId))) {
    return p.respond(c.html(renderNotFound(p.ctx), 404));
  }
  return p.respond(new Response(null, { status: 303, headers: { location: "/-/admin/applications" } }));
}

// --- the SPEC-0018 §3.1 notices arm (pages/admin-notices.tsx — upstream's
// /-/admin notices group, web.go:882-886; the shared adminPagePrologue; the
// writes add the §2.8 sameOriginGuard) -------------------------------------

/** GET /-/admin/notices (pages/admin-notices.tsx): the prologue → the paged
 *  DESC listing (25 per page, the module's loader). */
async function adminNoticesPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const p = await adminPagePrologue(c);
  if (!p.ok) return p.response;
  const data = await loadAdminNoticesData(c.env.DB, new URL(c.req.raw.url).searchParams);
  return p.respond(c.html(renderAdminNoticesPage(p.ctx, data)));
}

/**
 * POST /-/admin/notices/delete (upstream DeleteNotices, notice.go:46-63):
 * the §2.8 guard + the prologue, the §5.4 ids[] discipline (non-numeric and
 * non-positive entries ignored — the shared parseNoticeIds; an
 * empty-after-filter set deletes nothing), then the write. Upstream answers
 * flash + 200 REGARDLESS of matched rows; with no session-flash queue the
 * admin-dashboard's re-render idiom answers both arms: a fresh listing with
 * the delete_success flash at 200.
 */
async function adminNoticesDelete(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const p = await adminPagePrologue(c);
  if (!p.ok) return p.response;
  const form = await readUrlEncodedForm(c.req.raw);
  await deleteNoticesByIds(c.env.DB, parseNoticeIds(form.getAll("ids[]")));
  const data = await loadAdminNoticesData(c.env.DB, new URL(c.req.raw.url).searchParams);
  return p.respond(c.html(renderAdminNoticesPage(p.ctx, data, { kind: "positive", text: adminNoticesLocale.deleteSuccess })));
}

/**
 * POST /-/admin/notices/empty (upstream EmptyNotices, notice.go:66-75): the
 * same ladder, the ONE bare table-wide delete. Upstream redirects onto the
 * same GET; the re-render IS that reduction (the module header's note).
 */
async function adminNoticesEmpty(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const p = await adminPagePrologue(c);
  if (!p.ok) return p.response;
  await emptyNotices(c.env.DB);
  const data = await loadAdminNoticesData(c.env.DB, new URL(c.req.raw.url).searchParams);
  return p.respond(c.html(renderAdminNoticesPage(p.ctx, data, { kind: "positive", text: adminNoticesLocale.deleteSuccess })));
}

// --- the SPEC-0018 §3.2 config arm (pages/admin-config.tsx — upstream's
// /-/admin config group, web.go:788-794; the shared adminPagePrologue;
// GET-only — the ChangeConfig write is the §3.2 §-out) ----------------------

/** GET /-/admin/config (pages/admin-config.tsx): the prologue → the
 *  read-only summary over the declared non-secret wrangler vars (the env
 *  slice is the §3.2 rule-3 guarantee — secrets are not fields of the
 *  loader's input), the published settings constants and the build
 *  posture. */
async function adminConfigPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const p = await adminPagePrologue(c);
  if (!p.ok) return p.response;
  const data = await loadAdminConfigData(adminConfigVarsFromEnv(c.env));
  return p.respond(c.html(renderAdminConfigPage(p.ctx, data)));
}

/**
 * GET /{org}/teams/{id}/edit (pages/org-settings.tsx — upstream EditTeam,
 * routers/web/org/teams.go:495-510, tplTeamNew's edit arm): the org-teams
 * prologue, then the org-scoped team read — an unknown or foreign-org id
 * 404-shells (the detail slice's foreign-id rule).
 */
async function orgTeamEditPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveOrgTeamsRequest(c);
  if (!resolved.ok) return resolved.response;
  const { ctx, respond } = resolved;
  const route = resolved.route;
  if (route.family !== "org-team-edit" || route.id === undefined) return respond(await c.notFound()); // drift guard
  const team = await loadOrgTeamEditData(c.env.DB, resolved.org, route.id);
  if (team === null) return respond(c.html(renderNotFound(ctx), 404));
  return respond(
    c.html(renderOrgTeamEditPage(ctx, { org: resolved.org, team, form: teamEditFormFromTeam(team), error: null }), 200),
  );
}

/**
 * POST /{org}/teams/{id}/edit (upstream EditTeamPost over the landed
 * orgEditTeam arm): the §2.8 guard, the prologue, the org-scoped team read,
 * then the form write — the required-name and rename-collision failures
 * re-render at 200 with the banner and the submitted values (upstream's
 * RenderWithErr arms), success 303s onto the team's detail slice (upstream
 * redirects onto /teams/{lowername}; the slice keys on the id — the
 * org-teams route-shape note).
 */
async function orgTeamEditSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveOrgTeamsRequest(c);
  if (!resolved.ok) return resolved.response;
  const { ctx, org, respond } = resolved;
  const route = resolved.route;
  if (route.family !== "org-team-edit" || route.id === undefined) return respond(await c.notFound()); // drift guard
  const team = await loadOrgTeamEditData(c.env.DB, org, route.id);
  if (team === null) return respond(c.html(renderNotFound(ctx), 404));
  const form = parseOrgTeamEditForm(await readUrlEncodedForm(c.req.raw));
  const result = await applyOrgTeamEditForm(c.env.DB, team, form);
  if (result.outcome === "applied") {
    return respond(new Response(null, { status: 303, headers: { location: `/${org.username}/teams/${team.id}` } }));
  }
  return respond(c.html(renderOrgTeamEditPage(ctx, { org, team, form, error: result.message }), 200));
}

/**
 * POST /{org}/teams/{id}/delete (upstream DeleteTeam over the landed
 * orgDeleteTeam cascade): the §2.8 guard, the prologue, the org-scoped team
 * read, then the write — success 303s onto the teams list (upstream's
 * JSONRedirect target); the last-owner refusal 303s back onto the edit form
 * (upstream Flash.Error + the same unconditional redirect — no flash
 * plumbing, so the arms differ only in target).
 */
async function orgTeamDeleteSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveOrgTeamsRequest(c);
  if (!resolved.ok) return resolved.response;
  const { ctx, org, respond } = resolved;
  const route = resolved.route;
  if (route.family !== "org-team-delete" || route.id === undefined) return respond(await c.notFound()); // drift guard
  const team = await loadOrgTeamEditData(c.env.DB, org, route.id);
  if (team === null) return respond(c.html(renderNotFound(ctx), 404));
  const result = await applyOrgTeamDelete(c.env.DB, team);
  const location =
    result.outcome === "deleted" ? `/${org.username}/teams` : `/${org.username}/teams/${team.id}/edit`;
  return respond(new Response(null, { status: 303, headers: { location } }));
}

// ---------------------------------------------------------------------------
// The wave-8 file editor (pages/file-editor.tsx — upstream's
// _new/_edit/_delete editor Combos, web.go:1453-1461)
// ---------------------------------------------------------------------------

/** Parse family → page mode. */
const FILE_EDITOR_MODES = {
  "file-new": "new",
  "file-edit": "edit",
  "file-delete": "delete",
} as const;

/**
 * The editor prologue the GET and POST share (after the POST's §2.8 Origin
 * guard, and after each handler's own family drift check): the repo
 * resolution (invisible repos 404-shell before any redirect could leak
 * them), the anonymous login 303, then the write posture — the archived
 * refusal (upstream `RepoMustNotBeArchived` answers NotFound,
 * services/context/repo.go:136-141) and the write predicate (`canWriteRepo`,
 * the UI delegate onto the landed canWriteRepository, repo-access.ts via
 * ../repo-grants.ts — team grants included; non-writers
 * 404-shell like the settings pages — no fork-to-edit flow exists to offer
 * readers). Returns the ready Response, or null to proceed.
 */
async function fileEditorGate(
  c: Context<{ Bindings: Env }>,
  resolved: Extract<ResolvedUiRequest, { ok: true }>,
): Promise<Response | null> {
  const { url, ctx, viewer, repo, respond } = resolved;
  if (viewer.kind === "anonymous") return respond(loginRedirect(url.pathname + url.search));
  if (repo.isArchived || !(await canWriteRepo(c.env, repo, viewer))) {
    return respond(c.html(renderNotFound(ctx), 404));
  }
  return null;
}

/** GET /{owner}/{repo}/{new|edit|delete}/{branch}[/{path}] (the form;
 *  `?filename=` prefills the new-file name input — upstream 303s onto the
 *  path URL instead, editor.go:274-284, the header's documented
 *  simplification). */
/** The three families sharing the one-template loader (the upload and
 * cherrypick/patch tails carry their own handlers below). */
type FileEditorPageFamily = "file-new" | "file-edit" | "file-delete";

async function fileEditorPage(c: Context<{ Bindings: Env }>, family: FileEditorPageFamily): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const { url, ctx, repo, respond } = resolved;
  const route = resolved.route;
  if (route.family !== family) return respond(await c.notFound()); // registration/parser drift guard
  const gate = await fileEditorGate(c, resolved);
  if (gate !== null) return gate;
  const mode = FILE_EDITOR_MODES[family];
  const engine = engineClient(c.env, `${repo.ownerNamespace}/${repo.slug}`);
  const data = await loadFileEditorData(engine, repo, mode, route.refSuffix, url.searchParams.get("filename"));
  if ("notFound" in data) return respond(c.html(renderNotFound(ctx), 404));
  // Window-2e C2b: the delete family renders its DEDICATED confirm page
  // (repo-editor-tails' parity render — the pageClass discriminator,
  // ALL-links breadcrumb, PageIsDelete placeholder; the one-template render
  // stays the other two families').
  if (family === "file-delete") {
    return respond(c.html(renderEditorDeletePage({ ctx, data, form: editorFormFromData(data), error: null }), 200));
  }
  return respond(c.html(renderFileEditorPage({ ctx, data, form: editorFormFromData(data), error: null }), 200));
}

/**
 * POST /{owner}/{repo}/{new|edit|delete}/{branch}[/{path}] (upstream
 * EditFilePost / DeleteFilePost): the §2.8 layer-2 Origin guard FIRST, then
 * the GET's prologue, then the landed `applyFileChanges` through
 * `commitFileFromForm` — author = committer = the session viewer, the
 * blob-sha hidden field arming the service's CAS, the push-webhook family
 * riding the applied delta (pages/file-editor.tsx module header). A refused
 * edit (binary / too large — the GET's NotEditableReason) re-renders the
 * refusal; success 303s onto the file view on the target branch (upstream
 * redirectForCommitChoice's tail, editor.go:227-230; the delete lands on
 * the containing tree); every service arm re-renders the form at 200 with
 * the message and the submitted values (the login failure convention).
 */
async function fileEditorSubmit(c: Context<{ Bindings: Env }>, family: FileEditorPageFamily): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const { url, ctx, viewer, repo, respond } = resolved;
  const route = resolved.route;
  if (route.family !== family) return respond(await c.notFound()); // registration/parser drift guard
  const gate = await fileEditorGate(c, resolved);
  if (gate !== null) return gate;
  if (viewer.kind !== "user") return respond(c.html(renderNotFound(ctx), 404)); // the gate above admitted only users
  const userRow = await drizzle(c.env.DB).select().from(users).where(eq(users.id, viewer.id)).get();
  if (userRow === undefined) return respond(c.html(renderNotFound(ctx), 404)); // the session doer vanished
  const mode = FILE_EDITOR_MODES[family];
  const engine = engineClient(c.env, `${repo.ownerNamespace}/${repo.slug}`);
  const data = await loadFileEditorData(engine, repo, mode, route.refSuffix, url.searchParams.get("filename"));
  if ("notFound" in data) return respond(c.html(renderNotFound(ctx), 404));
  const values = await readEditorForm(c.req.raw);
  if (data.notEditableReason !== null) {
    // The refusal stands on POST too (upstream's content-absent degenerate
    // arm — editor.go:345-357 — reduced to the page's own message).
    const refusalRender = family === "file-delete" ? renderEditorDeletePage : null;
    if (refusalRender !== null) {
      return respond(c.html(refusalRender({ ctx, data, form: editorFormFromData(data), error: null }), 200));
    }
    return respond(c.html(renderFileEditorPage({ ctx, data, form: editorFormFromData(data), error: null }), 200));
  }
  const result = await commitFileFromForm(c.env, c.req.raw, repo, userRow, mode, values);
  const repoLink = `/${repo.ownerNamespace}/${repo.slug}`;
  if (result.outcome === "committed") {
    const branchPart = `${repoLink}/src/branch/${pathEscapeSegments(result.branch)}`;
    const location =
      mode === "delete"
        ? result.treePath.includes("/")
          ? `${branchPart}/${pathEscapeSegments(result.treePath.slice(0, result.treePath.lastIndexOf("/")))}`
          : branchPart
        : `${branchPart}/${pathEscapeSegments(result.treePath)}`;
    return respond(new Response(null, { status: 303, headers: { location } }));
  }
  if (family === "file-delete") {
    return respond(c.html(renderEditorDeletePage({ ctx, data, form: values, error: result.message }), 200));
  }
  return respond(c.html(renderFileEditorPage({ ctx, data, form: values, error: result.message }), 200));
}

// ---------------------------------------------------------------------------
// Window-2e C2b: the upload page + the cherrypick/patch pages (the editor
// family's gate and commit-identity conventions).
// ---------------------------------------------------------------------------

async function fileUploadPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const { ctx, repo, respond } = resolved;
  if (resolved.route.family !== "file-upload") return respond(await c.notFound()); // drift guard
  const gate = await fileEditorGate(c, resolved);
  if (gate !== null) return gate;
  const engine = engineClient(c.env, `${repo.ownerNamespace}/${repo.slug}`);
  const data = await loadEditorUploadData(engine, repo, resolved.route.refSuffix);
  if ("notFound" in data) return respond(c.html(renderNotFound(ctx), 404));
  return respond(c.html(renderEditorUploadPage({ ctx, data, form: uploadFormFromData(data), error: null }), 200));
}

async function fileUploadSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const { ctx, viewer, repo, respond } = resolved;
  if (resolved.route.family !== "file-upload") return respond(await c.notFound()); // drift guard
  const gate = await fileEditorGate(c, resolved);
  if (gate !== null) return gate;
  if (viewer.kind !== "user") return respond(c.html(renderNotFound(ctx), 404)); // the gate above admitted only users
  const userRow = await drizzle(c.env.DB).select().from(users).where(eq(users.id, viewer.id)).get();
  if (userRow === undefined) return respond(c.html(renderNotFound(ctx), 404)); // the session doer vanished
  const engine = engineClient(c.env, `${repo.ownerNamespace}/${repo.slug}`);
  const data = await loadEditorUploadData(engine, repo, resolved.route.refSuffix);
  if ("notFound" in data) return respond(c.html(renderNotFound(ctx), 404));
  const form = parseUploadForm(await readUrlEncodedForm(c.req.raw));
  const result = await commitUploadFromForm(c.env, c.req.raw, repo, userRow, form);
  if (result.outcome === "committed") {
    const branchPart = `/${repo.ownerNamespace}/${repo.slug}/src/branch/${pathEscapeSegments(result.branch)}`;
    return respond(new Response(null, { status: 303, headers: { location: branchPart } }));
  }
  if (result.outcome === "noop") {
    // Zero staged uuids — upstream answers nil (upload.go:78-80); the
    // no-JS reduction redirects back (nothing to re-render).
    return respond(new Response(null, { status: 303, headers: { location: `/${repo.ownerNamespace}/${repo.slug}/upload/${pathEscapeSegments(form.branch)}` } }));
  }
  return respond(c.html(renderEditorUploadPage({ ctx, data, form, error: result.message }), 200));
}

async function editorCherryPickPage(c: Context<{ Bindings: Env }>, isPost: boolean): Promise<Response> {
  if (isPost) {
    const guard = sameOriginGuard(c.req.raw);
    if (guard !== null) return guard;
  }
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const { url, ctx, viewer, repo, respond } = resolved;
  if (resolved.route.family !== "editor-cherrypick") return respond(await c.notFound()); // drift guard
  const gate = await fileEditorGate(c, resolved);
  if (gate !== null) return gate;
  const engine = engineClient(c.env, `${repo.ownerNamespace}/${repo.slug}`);
  const data = await loadEditorCherryPickData(engine, repo, resolved.route.refSuffix, url.searchParams.get("cherry-pick-type"));
  if ("notFound" in data) return respond(c.html(renderNotFound(ctx), 404));
  if (!isPost) {
    return respond(c.html(renderEditorCherryPickPage({ ctx, data, form: cherryPickFormFromData(data), error: null }), 200));
  }
  if (viewer.kind !== "user") return respond(c.html(renderNotFound(ctx), 404));
  const userRow = await drizzle(c.env.DB).select().from(users).where(eq(users.id, viewer.id)).get();
  if (userRow === undefined) return respond(c.html(renderNotFound(ctx), 404));
  const split = splitCherryPickSuffix(resolved.route.refSuffix);
  if (split === null) return respond(await c.notFound());
  const form = await readCherryPickForm(c.req.raw);
  const result = await commitCherryPickFromForm(c.env, c.req.raw, repo, userRow, split.sha, form);
  if (result.outcome === "committed") {
    return respond(
      new Response(null, {
        status: 303,
        headers: { location: `/${repo.ownerNamespace}/${repo.slug}/src/branch/${pathEscapeSegments(result.branch)}` },
      }),
    );
  }
  return respond(c.html(renderEditorCherryPickPage({ ctx, data, form, error: result.message }), 200));
}

async function editorPatchPage(c: Context<{ Bindings: Env }>, isPost: boolean): Promise<Response> {
  if (isPost) {
    const guard = sameOriginGuard(c.req.raw);
    if (guard !== null) return guard;
  }
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const { ctx, viewer, repo, respond } = resolved;
  if (resolved.route.family !== "editor-patch") return respond(await c.notFound()); // drift guard
  const gate = await fileEditorGate(c, resolved);
  if (gate !== null) return gate;
  const engine = engineClient(c.env, `${repo.ownerNamespace}/${repo.slug}`);
  const data = await loadEditorPatchData(engine, repo, resolved.route.refSuffix);
  if ("notFound" in data) return respond(c.html(renderNotFound(ctx), 404));
  if (!isPost) {
    return respond(c.html(renderEditorPatchPage({ ctx, data, form: patchFormFromData(data), error: null }), 200));
  }
  if (viewer.kind !== "user") return respond(c.html(renderNotFound(ctx), 404));
  const userRow = await drizzle(c.env.DB).select().from(users).where(eq(users.id, viewer.id)).get();
  if (userRow === undefined) return respond(c.html(renderNotFound(ctx), 404));
  const form = await readPatchForm(c.req.raw);
  const result = await commitPatchFromForm(c.env, c.req.raw, repo, userRow, form);
  if (result.outcome === "committed") {
    return respond(
      new Response(null, {
        status: 303,
        headers: { location: `/${repo.ownerNamespace}/${repo.slug}/src/branch/${pathEscapeSegments(result.branch)}` },
      }),
    );
  }
  return respond(c.html(renderEditorPatchPage({ ctx, data, form, error: result.message }), 200));
}

/**
 * GET / — the site root (pages/dashboard.tsx — upstream `Home`,
 * routers/web/home.go:26-44): the session prologue WITHOUT the repo read,
 * then the viewer-kind dispatch — a signed-in viewer gets the dashboard
 * (pages wave 9: the derived-thread activity lines + the own/watched repo
 * lists), an anonymous viewer the upstream landing page. Only the manifest
 * half can fail here (the 503); the page reads degrade per their loaders.
 */
async function siteHomePage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiSession(c);
  if (!resolved.ok) return resolved.response;
  const { ctx, viewer, respond } = resolved;
  if (viewer.kind === "user") {
    const data = await loadDashboardData(c.env.DB, viewer);
    return respond(c.html(renderDashboardPage(ctx, data), 200));
  }
  return respond(c.html(renderLandingPage(ctx), 200));
}

/**
 * GET /explore — upstream web.go:550-552: a plain redirect onto the repos
 * page (upstream ctx.Redirect, 303 per base.go:157).
 */
function exploreRoot(): Response {
  return new Response(null, { status: 303, headers: { location: "/explore/repos" } });
}

/** GET /explore/repos (pages/explore.tsx — the repo search page; anonymous
 *  sees public rows, a session viewer gains their own private repos — the
 *  upstream `Private: ctx.Doer != nil` scope in the search service seam). */
async function exploreReposPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiSession(c);
  if (!resolved.ok) return resolved.response;
  const { url, ctx, viewer, respond } = resolved;
  const data = await loadExploreReposData(c.env.DB, viewer, url.searchParams);
  return respond(c.html(renderExploreReposPage(ctx, data), 200));
}

/** GET /explore/users (pages/explore.tsx — the user search page; the
 *  landed user-search predicate + the upstream Types/IsActive gates). */
async function exploreUsersPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiSession(c);
  if (!resolved.ok) return resolved.response;
  const { url, ctx, respond } = resolved;
  const data = await loadExploreUsersData(c.env.DB, url.searchParams);
  return respond(c.html(renderExploreUsersPage(ctx, data), 200));
}

/** GET /explore/organizations (pages/explore.tsx — this wave's org search
 *  page; org.go:17's Organizations over the same tplExploreUsers template —
 *  anonymous sees public orgs, a signed-in viewer all three visibilities,
 *  org.go:31-34's switch). */
async function exploreOrganizationsPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiSession(c);
  if (!resolved.ok) return resolved.response;
  const { url, ctx, viewer, respond } = resolved;
  const data = await loadExploreOrganizationsData(c.env.DB, viewer, url.searchParams);
  return respond(c.html(renderExploreOrganizationsPage(ctx, data), 200));
}

/** GET /explore/code (pages/explore-code.tsx — the SPEC-0019 M2 code search
 *  page; upstream web.go:558's literal, code.go's explore.Code): the
 *  exploreReposPage twin — the session prologue, then the federation scan
 *  over every viewer-visible repo (the bare form answers without a seed
 *  read, the module's early-return arm). */
async function exploreCodePage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiSession(c);
  if (!resolved.ok) return resolved.response;
  const { url, ctx, viewer, respond } = resolved;
  const data = await loadExploreCodeSearchData(c.env, c.env.DB, viewer, url.searchParams);
  return respond(c.html(renderExploreCodePage(ctx, data), 200));
}

/** GET /{username}/-/heatmap (pages/owner-heatmap.ts — this wave's web JSON
 *  arm; upstream heatmap.go:32-63's DashboardHeatmap): the owner resolves
 *  through the profile page's seam (the IsUserVisibleToViewer ladder — the
 *  gate's miss is the 404 shell; a renamed user 307s like the page), then
 *  the re-issued aggregation answers the web pair shape. */
async function ownerHeatmapData(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiSession(c);
  if (!resolved.ok) return resolved.response;
  const { route, ctx, viewer, respond } = resolved;
  if (route.family !== "owner-heatmap") return respond(await c.notFound()); // drift guard
  const doer: ProfileDoer =
    viewer.kind === "user" ? { id: viewer.id, isAdmin: viewer.isAdmin } : { id: null, isAdmin: false };
  const owner = await resolveUserProfile(c.env.DB, route.owner, doer, resolved.url.pathname, resolved.url.search);
  if (owner.kind === "redirect") {
    return respond(new Response(null, { status: 307, headers: { location: owner.location } }));
  }
  if (owner.kind === "missing") return respond(c.html(renderNotFound(ctx), 404));
  const load = await loadOwnerHeatmapData(c.env.DB, owner.user);
  if (load === null) return respond(c.html(renderNotFound(ctx), 404)); // the gate's miss class
  return respond(c.json(JSON.parse(ownerHeatmapJsonBody(load))));
}

/** GET /{owner}/-/code (pages/user-code-search.tsx — the codesearch-M1
 *  owner code-search page; upstream user.CodeSearch, web.go:1136 in the
 *  `/{username}/-` group): the heatmap twin's resolution shape — the owner
 *  ladder (a renamed owner 307s, an invisible one 404-shells; the packages
 *  family's owner-resolution twin WITHOUT the package-access gate), then
 *  the federated seed search over the owner's visible repos. */
async function userCodeSearchPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiSession(c);
  if (!resolved.ok) return resolved.response;
  const { route, ctx, viewer, respond } = resolved;
  if (route.family !== "user-code-search") return respond(await c.notFound()); // drift guard
  const doer: ProfileDoer =
    viewer.kind === "user" ? { id: viewer.id, isAdmin: viewer.isAdmin } : { id: null, isAdmin: false };
  const owner = await resolveUserCodeSearchOwner(
    c.env.DB,
    route.owner,
    doer,
    resolved.url.pathname,
    resolved.url.search,
  );
  if (owner.kind === "redirect") {
    return respond(new Response(null, { status: 307, headers: { location: owner.location } }));
  }
  if (owner.kind === "missing") return respond(c.html(renderNotFound(ctx), 404));
  const data = await loadUserCodeSearchData(c.env, c.env.DB, owner, doer, resolved.url.searchParams);
  return respond(c.html(renderUserCodeSearchPage(ctx, data), 200));
}

/**
 * GET /org/{org}/{issues|pulls|milestones}[/{team}] (pages/org-inbox.tsx —
 * this wave's R07): the RequireMember/RequireTeamMember ladder — anonymous
 * and non-members 404-shell (OrgAssignment never 303s), a renamed org 307s
 * — then the parameterized overview loaders with the org repo-set scope.
 */
async function orgInboxPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiSession(c);
  if (!resolved.ok) return resolved.response;
  const { route, ctx, viewer, respond } = resolved;
  if (route.family !== "org-inbox") return respond(await c.notFound()); // drift guard
  const resolution = await resolveOrgInbox(
    c.env.DB,
    route.owner,
    viewer,
    resolved.url.pathname,
    resolved.url.search,
    route.team ?? null,
  );
  if (resolution.kind === "redirect") {
    return respond(new Response(null, { status: 307, headers: { location: resolution.location } }));
  }
  if (resolution.kind === "missing") return respond(c.html(renderNotFound(ctx), 404));
  const kind: OrgInboxKind = route.kind;
  const chrome = {
    orgName: resolution.org.username,
    visibility: resolution.org.visibility,
    teamName: resolution.scope.teamName,
  };
  if (kind === "milestones") {
    const data = await loadOrgInboxMilestonesData(c.env.DB, viewer, resolved.url.searchParams, resolution.scope);
    return respond(c.html(renderOrgInboxMilestonesPage(ctx, data, chrome), 200));
  }
  const data = await loadOrgInboxIssuesData(c.env.DB, viewer, kind, resolved.url.searchParams, resolution.scope);
  return respond(c.html(renderOrgInboxIssuesPage(ctx, data, chrome), 200));
}

// ---------------------------------------------------------------------------
// The wave-10 notifications family (pages/notifications.tsx — upstream
// web.go:1784-1791's reqSignIn group)
// ---------------------------------------------------------------------------

/** GET /notifications — upstream Notifications (user/notification.go:38-46):
 *  the signed-in mailbox; anonymous 303s onto the login round-trip. The
 *  `?div-only=1` arm answers the bare `#notification_div` fragment the
 *  official bundle's live table refresh fetches (features/notification.ts). */
async function notificationsPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiSession(c);
  if (!resolved.ok) return resolved.response;
  const { url, ctx, viewer, respond } = resolved;
  if (viewer.kind === "anonymous") return respond(loginRedirect(url.pathname + url.search));
  // The tab param is upstream's two-arg FormString default shape —
  // `FormString("type", FormString("q"))` (notification.go:69): the legacy
  // `?q=` alias feeds the same tab select when `type` is absent (the `??`
  // null-shape matches Go's only-when-absent default; a present-but-empty
  // `type` keeps its junk and folds to unread exactly like upstream).
  const pageType = parseNotificationPageType(url.searchParams.get("type") ?? url.searchParams.get("q"));
  const page = parsePageNumber(url.searchParams.get("page"));
  const sequenceNumber = url.searchParams.get("sequence-number") ?? "";
  // The navbar resolution already computed the unread count for this
  // request — one COUNT, not two (pages/notifications.tsx loader).
  const data = await loadNotificationsData(c.env.DB, viewer.id, pageType, page, ctx.notificationCount ?? undefined);
  if (parseFormBool(url.searchParams.get("div-only"))) {
    return respond(c.html(renderNotificationDiv(data, sequenceNumber), 200));
  }
  return respond(c.html(renderNotificationsPage(ctx, data, sequenceNumber), 200));
}

/** GET /notifications/new — upstream NewAvailable (notification.go:433-446):
 *  the unread count as `{new: N}` JSON for the bundle's live badge; a failed
 *  read degrades `{new: 0}` exactly like upstream's error arm. */
async function notificationsNew(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiSession(c);
  if (!resolved.ok) return resolved.response;
  const { url, viewer, respond } = resolved;
  if (viewer.kind === "anonymous") return respond(loginRedirect(url.pathname + url.search));
  const count = await countUnreadNotifications(c.env.DB, viewer.id).catch(() => 0);
  return respond(c.json({ new: count }, 200));
}

/**
 * POST /notifications/status — upstream NotificationStatusPost
 * (notification.go:167-189): the per-row status write (mark_as_read /
 * mark_as_unread / pin through the landed SetNotificationStatus semantics),
 * then the FRESH DIV FRAGMENT as the answer (upstream renders
 * tplNotificationDiv; the bundle's fetch-action JS morphs it into the page
 * via the form's `data-fetch-sync`). An id that is not the caller's mailbox
 * thread 404-shells (the landed API PATCH's miss family — existence hidden;
 * upstream answers ServerError here, the documented divergence), an unknown
 * action is ignored with an empty 200 (upstream `default: return`).
 */
async function notificationStatusSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveUiSession(c);
  if (!resolved.ok) return resolved.response;
  const { url, ctx, viewer, respond } = resolved;
  if (viewer.kind === "anonymous") return respond(loginRedirect(url.pathname + url.search));
  const { id, action } = parseNotificationStatusForm(await readUrlEncodedForm(c.req.raw));
  if (action === null) {
    // Unknown action — ignored with an empty 200 (upstream `default: return`).
    return respond(new Response(null, { status: 200 }));
  }
  const marked = await markNotificationThread(c.env.DB, viewer.id, { id, action }, new Date());
  if (!marked) return respond(c.html(renderNotFound(ctx), 404));
  // The re-render keeps the current query's tab/page/sequence (upstream
  // prepareUserNotificationsData over the posted PageQueryParams — the same
  // notification.go:69 read, so the legacy `?q=` alias rides the re-render
  // the same way it rides the GET page above).
  const pageType = parseNotificationPageType(url.searchParams.get("type") ?? url.searchParams.get("q"));
  const page = parsePageNumber(url.searchParams.get("page"));
  const sequenceNumber = url.searchParams.get("sequence-number") ?? "";
  const data = await loadNotificationsData(c.env.DB, viewer.id, pageType, page);
  return respond(c.html(renderNotificationDiv(data, sequenceNumber), 200));
}

/**
 * POST /notifications/purge — upstream NotificationPurgePost
 * (notification.go:191-199): every unread thread marked read, answered with
 * the JSONRedirect shape (`{"redirect": …}`, context.go:239-241) the
 * bundle's link-action JS follows.
 */
async function notificationPurgeSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveUiSession(c);
  if (!resolved.ok) return resolved.response;
  const { url, viewer, respond } = resolved;
  if (viewer.kind === "anonymous") return respond(loginRedirect(url.pathname + url.search));
  await purgeNotifications(c.env.DB, viewer.id, new Date());
  return respond(c.json({ redirect: "/notifications" }, 200));
}

/**
 * POST /notifications/purge-page — upstream NotificationPurgePagePost
 * (notification.go:207-218): the posted id list filtered to the caller's
 * mailbox (foreign/unknown ids silently drop — upstream FormInt64s then
 * the same per-thread filter), each marked read, answered with the bare
 * JSONRedirect (`{"redirect": ""}` — context.go:239-241 over an empty
 * redirect; the fragment chrome stays unrendered, the dead-surface note).
 * The matrix-6 interim 404 pin flips with this mount.
 */
async function notificationPurgePageSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveUiSession(c);
  if (!resolved.ok) return resolved.response;
  const { viewer, respond } = resolved;
  if (viewer.kind === "anonymous") return respond(loginRedirect("/notifications"));
  const form = await readUrlEncodedForm(c.req.raw);
  const ids = (form.get("ids") ?? "")
    .split(",")
    .map((part) => Number.parseInt(part.trim(), 10))
    .filter((id) => Number.isInteger(id) && id > 0);
  const now = new Date();
  const marks = [];
  for (const id of new Set(ids)) {
    if (await isOwnMailboxThread(c.env.DB, viewer.id, id)) {
      marks.push(markThread(c.env.DB, viewer.id, id, "read", now));
    }
  }
  if (marks.length > 0) {
    const [first, ...rest] = marks;
    await drizzle(c.env.DB).batch([first!, ...rest]);
  }
  return respond(c.json({ redirect: "" }, 200));
}

/**
 * POST /{owner}/{repo}/{issues|pulls}/{index}/comments (pages/issue-detail.tsx
 * — upstream NewComment, routers/web/repo/issue_comment.go:37-118): the §2.8
 * Origin guard, the same repo→viewer order as the GET pages (invisible repos
 * 404 before the redirect could leak them), then the landed
 * `IssuesService.addComment` (+ the `status` close/reopen through
 * closeIssue/reopenIssue). Success 303s onto the row's OWN family page with
 * the `#issuecomment-{id}` anchor when a comment was created (upstream
 * `redirect += "#" + comment.HashTag()`); validation failures re-render the
 * detail page at 200 with the message and the kept draft (the login failure
 * convention).
 */
async function issueCommentSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const { url, ctx, viewer, repo, respond } = resolved;
  const route = resolved.route;
  if (route.family !== "issue-comment") return respond(await c.notFound()); // registration/parser drift guard
  if (viewer.kind === "anonymous") return respond(loginRedirect(url.pathname + url.search));

  const issue = await findIssueByRepoAndIndex(c.env.DB, repo.id, route.index);
  if (issue === null) return respond(c.html(renderNotFound(ctx), 404));
  const repoLink = `/${repo.ownerNamespace}/${repo.slug}`;
  // The redirect target is the ROW's own family (upstream issueType,
  // issue_comment.go:70) — a POST through the twin family still lands
  // canonically. The cross-family GET redirect stays the detail route's.
  const canonicalPath = `${repoLink}/${issue.isPull ? "pulls" : "issues"}/${issue.index}`;

  const form = parseCommentForm(await readUrlEncodedForm(c.req.raw));
  // The merged-PR guard needs the PR extension row only.
  const pr = issue.isPull ? ((await findPullRequestByIndex(c.env.DB, repo.id, route.index))?.pullRequest ?? null) : null;
  const access = await resolveIssueDetailAccess(c.env, repo, viewer, issue);
  const result = await createCommentFromForm(c.env.DB, repo, issue, pr, viewer, access, form);
  if (result.outcome === "created") {
    return respond(new Response(null, { status: 303, headers: { location: `${canonicalPath}#issuecomment-${result.comment.id}` } }));
  }
  if (result.outcome === "state-only") {
    return respond(new Response(null, { status: 303, headers: { location: canonicalPath } }));
  }
  // Re-render with the message and the kept draft (the new-issue convention).
  const data = await loadIssueDetailData(c.env.DB, repo, route.urlKind, route.index, url.origin, viewer);
  if (data === null) return respond(c.html(renderNotFound(ctx), 404));
  return respond(c.html(renderIssueDetailPage(ctx, data, access, { content: form.content, error: result.message }), 200));
}

/**
 * POST /{owner}/{repo}/issues/labels (pages/issue-detail.tsx — the sidebar
 * label edit): admin viewers only (`canAdminRepo` — the settings predicate;
 * anonymous 303s onto the login round-trip, a signed-in non-admin 404-
 * shells). The submitted `label_ids` set REPLACES the issue's labels through
 * the landed `IssuesService.replaceLabels` (diff-based attach/detach with
 * the counter maintenance); success 303s onto the issue's canonical page,
 * the service's NoSuchLabel message re-renders inline.
 */
async function issueLabelsSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const { url, ctx, viewer, repo, respond } = resolved;
  if (viewer.kind === "anonymous") return respond(loginRedirect(url.pathname + url.search));
  if (!(await canAdminRepo(c.env, repo, viewer))) return respond(c.html(renderNotFound(ctx), 404));

  const form = parseIssueLabelForm(await readUrlEncodedForm(c.req.raw));
  // The issue_ids selector scopes GLOBAL label ids to THIS repo's issues
  // (upstream getActionIssues' repo check) — a foreign id 404-shells.
  const issue = form.issueId === null ? null : await new IssuesService(c.env.DB).getIssueById(form.issueId);
  if (issue === null || issue.repoId !== repo.id) return respond(c.html(renderNotFound(ctx), 404));

  const result = await applyIssueLabels(c.env.DB, issue, form);
  const canonicalPath = `/${repo.ownerNamespace}/${repo.slug}/${issue.isPull ? "pulls" : "issues"}/${issue.index}`;
  if (result.outcome === "applied") {
    return respond(new Response(null, { status: 303, headers: { location: canonicalPath } }));
  }
  const data = await loadIssueDetailData(c.env.DB, repo, issue.isPull ? "pulls" : "issues", issue.index, url.origin, viewer);
  if (data === null) return respond(c.html(renderNotFound(ctx), 404));
  const access = await resolveIssueDetailAccess(c.env, repo, viewer, issue);
  return respond(c.html(renderIssueDetailPage(ctx, data, access, { content: "", error: result.message }), 200));
}

/**
 * POST /{owner}/{repo}/pulls/{index}/files/reviews/submit (pages/
 * pull-reviews.tsx — upstream SubmitReview, routers/web/repo/pull_review.go
 * :222-270 over the landed create-review arm's pipeline): the §2.8 Origin
 * guard, the repo→viewer order, then the landed SubmitReview port — the
 * verdict select maps approve/comment/reject onto the wire events, the
 * poster's self-approval/self-rejection and the REQUEST_CHANGES body
 * requirement 422 the same messages, the head tip resolves the absent
 * commit, the CommentTypeReview system comment lands with the review, and
 * the webhook family rides the write. Success 303s onto
 * `pulls/{index}#issuecomment-{id}` (upstream JSONRedirect's
 * `comm.HashTag()` target — CommentHashTag, comment.go:554-556); the
 * re-render carries the message + kept draft (the login failure convention).
 */
async function pullReviewSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const { url, ctx, viewer, repo, respond } = resolved;
  const route = resolved.route;
  if (route.family !== "pull-review-submit" || route.index === undefined) return respond(await c.notFound());
  if (viewer.kind === "anonymous") return respond(loginRedirect(url.pathname + url.search));
  // RepoMustNotBeArchived wraps upstream's reviews group (web.go:1677).
  if (repo.isArchived) return respond(c.html(renderNotFound(ctx), 404));

  const issue = await findIssueByRepoAndIndex(c.env.DB, repo.id, route.index);
  if (issue === null || !issue.isPull) return respond(c.html(renderNotFound(ctx), 404)); // upstream `if !issue.IsPull`
  const joined = await findPullRequestByIndex(c.env.DB, repo.id, route.index);
  if (joined === null) return respond(c.html(renderNotFound(ctx), 404));
  const pair = await findRepositoryById(c.env.DB, repo.id);
  if (pair === null) return respond(c.html(renderNotFound(ctx), 404));

  const repoLink = `/${repo.ownerNamespace}/${repo.slug}`;
  const form = parseReviewSubmitForm(await readUrlEncodedForm(c.req.raw));
  try {
    const result = await submitReviewFromForm({
      request: c,
      origin: url.origin,
      pair,
      repo,
      issue,
      pr: joined.pullRequest,
      doerId: viewer.id,
      form,
    });
    return respond(
      new Response(null, { status: 303, headers: { location: `${repoLink}/pulls/${issue.index}#issuecomment-${result.commentId}` } }),
    );
  } catch (error) {
    const message = pullReviewErrorMessage(error);
    if (message === null) throw error;
    const data = await loadIssueDetailData(c.env.DB, repo, "pulls", route.index, url.origin, viewer);
    if (data === null) return respond(c.html(renderNotFound(ctx), 404));
    const access = await resolveIssueDetailAccess(c.env, repo, viewer, data.issue);
    return respond(c.html(renderIssueDetailPage(ctx, data, access, undefined, { content: form.content, error: message }), 200));
  }
}

/**
 * POST /{owner}/{repo}/issues/request_review (pages/pull-reviews.tsx —
 * upstream UpdatePullReviewRequest, routers/web/repo/pull_review.go:339
 * over the landed request arms): the sameOriginGuard + repo→viewer order,
 * the issue resolved from `issue_ids` (the labels-write pattern — upstream
 * getActionIssues' field), then attach (the no-JS `reviewer` NAME through
 * the landed resolver) or detach (upstream's numeric `id`). Success 303s
 * onto the PR's canonical page (the link-action reload upstream's JS
 * performs); failures re-render the PR detail page with the landed message
 * under the Reviewers control (upstream flashes/403s — the re-render is the
 * no-JS convention).
 */
async function pullReviewRequestSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const { url, ctx, viewer, repo, respond } = resolved;
  const route = resolved.route;
  if (route.family !== "issue-request-review") return respond(await c.notFound());
  if (viewer.kind === "anonymous") return respond(loginRedirect(url.pathname + url.search));
  if (repo.isArchived) return respond(c.html(renderNotFound(ctx), 404)); // RepoMustNotBeArchived (web.go:1419-1421)

  const form = parseReviewRequestForm(await readUrlEncodedForm(c.req.raw));
  // The issue_ids selector scopes GLOBAL issue ids to THIS repo (upstream
  // getActionIssues' repo check) — a foreign id or a non-PR 404-shells
  // (upstream answers Status(403) for the non-PR arm; the shell hides it).
  const issue = form.issueId === null ? null : await new IssuesService(c.env.DB).getIssueById(form.issueId);
  if (issue === null || issue.repoId !== repo.id || !issue.isPull) return respond(c.html(renderNotFound(ctx), 404));
  const joined = await findPullRequestByIndex(c.env.DB, repo.id, issue.index);
  if (joined === null) return respond(c.html(renderNotFound(ctx), 404));
  const pair = await findRepositoryById(c.env.DB, repo.id);
  if (pair === null) return respond(c.html(renderNotFound(ctx), 404));

  const canonicalPath = `/${repo.ownerNamespace}/${repo.slug}/pulls/${issue.index}`;
  try {
    await changeReviewRequestFromForm({
      request: c,
      origin: url.origin,
      pair,
      repo,
      issue,
      pr: joined.pullRequest,
      doerId: viewer.id,
      form,
    });
    return respond(new Response(null, { status: 303, headers: { location: canonicalPath } }));
  } catch (error) {
    const message = pullReviewErrorMessage(error);
    if (message === null) throw error;
    const data = await loadIssueDetailData(c.env.DB, repo, "pulls", issue.index, url.origin, viewer);
    if (data === null) return respond(c.html(renderNotFound(ctx), 404));
    const access = await resolveIssueDetailAccess(c.env, repo, viewer, data.issue);
    return respond(c.html(renderIssueDetailPage(ctx, data, access, undefined, undefined, message), 200));
  }
}

/** The gate's plain-text error shape (the dismiss arm's non-form states —
 *  upstream's own dismiss handler answers bare statuses, pull_review.go
 *  :288-291). */
function pullReviewStatusError(status: number, message: string): Response {
  return new Response(`${message}\n`, {
    status,
    headers: { "content-type": "text/plain;charset=utf-8", "x-content-type-options": "nosniff" },
  });
}

/**
 * POST /{owner}/{repo}/issues/dismiss_review (pages/pull-reviews.tsx —
 * upstream DismissReview, routers/web/repo/pull_review.go:280-293 over the
 * landed dismissal arm): the settings predicate stands in for reqRepoAdmin
 * (web.go:1436 — non-admins 404-shell, the settingsGate posture), then the
 * landed port (approve/reject rows only, closed/merged 403, the flag flip,
 * the CommentTypeDismissReview comment). Success 303s onto
 * `pulls/{index}#issuecomment-{id}` (upstream's redirect target).
 */
async function pullReviewDismissSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const { url, ctx, viewer, repo, respond } = resolved;
  const route = resolved.route;
  if (route.family !== "issue-dismiss-review") return respond(await c.notFound());
  if (viewer.kind === "anonymous") return respond(loginRedirect(url.pathname + url.search));
  if (!(await canAdminRepo(c.env, repo, viewer))) return respond(c.html(renderNotFound(ctx), 404)); // reqRepoAdmin
  if (repo.isArchived) return respond(c.html(renderNotFound(ctx), 404)); // RepoMustNotBeArchived (web.go:1436's group)

  const form = parseDismissReviewForm(await readUrlEncodedForm(c.req.raw));
  if (form.reviewId === null) return respond(c.html(renderNotFound(ctx), 404));
  try {
    const result = await dismissReviewFromForm({
      request: c,
      repoId: repo.id,
      doerId: viewer.id,
      reviewId: form.reviewId,
      message: form.message,
    });
    return respond(
      new Response(null, {
        status: 303,
        headers: { location: `/${repo.ownerNamespace}/${repo.slug}/pulls/${result.issueIndex}#issuecomment-${result.commentId}` },
      }),
    );
  } catch (error) {
    if (error instanceof PullReviewError) {
      if (error.status === 404) return respond(c.html(renderNotFound(ctx), 404));
      return respond(pullReviewStatusError(error.status, error.message));
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// The wave-13 compare family (pages/compare.tsx — upstream's /compare group,
// web.go:1307-1315, CompareDiff + CompareAndPullRequestPost)
// ---------------------------------------------------------------------------

/** GET /{owner}/{repo}/compare[/{base}...{head}] (pages/compare.tsx — the
 *  comparison view; every viewer who can see the repo reads it; the create
 *  form's pulls-reader gate rides along as `canCreate` — the branch-kinds arm
 *  (upstream allowCreatePull's IsBranch pair) reads the loaded data, so the
 *  gate computes AFTER the load. The gate is the READ grant the prologue
 *  already ran: upstream's template arm `and .IsSigned .PageIsComparePull`
 *  over allowCreatePull's `permBase.CanReadIssuesOrPulls(true)`
 *  (routers/web/repo/compare.go:305) admits any pulls reader, and the §2.5
 *  resolveRepositoryForViewer grant IS that read for the always-on pulls
 *  unit — the former `canWriteRepo` divergence is flipped (the fork-PR
 *  author holds no write on the base; upstream's POST chain admits the same
 *  class via reqUnitPullsReader, web.go:933 + services/context/permission.go:
 *  64-76). */
async function comparePage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const { url, ctx, viewer, repo, respond } = resolved;
  const route = resolved.route;
  // Window-2e B2: the .diff/.patch byte feeds share the compare
  // registration — the parser's compare-feed family branches here before
  // the page drift guard (web.go:1309-1310 vs the page route).
  if (route.family === "compare-feed" && route.segment !== undefined && route.ext !== undefined) {
    const repoFeed: CompareFeedRepo = {
      ownerNamespace: repo.ownerNamespace,
      slug: repo.slug,
      isEmpty: repo.isEmpty,
      defaultBranch: repo.defaultBranch,
    };
  // The viewer wiring (the compare unit's open issue 1): passing the
  // route-prologue viewer activates the loader's full §2.5 arm — the signed-in
  // reader's grant resolves on the head repo (private forks serve their
  // readers; anonymous keeps the conservative public-only grant).
  const result = await loadCompareFeed(c.env, repoFeed, route.segment, route.ext, viewer);
  if (result.kind === "notFound") return respond(c.html(renderNotFound(ctx), 404));
  if (result.kind === "noMergeBase") return respond(compareFeedServerErrorResponse());
  return respond(compareFeedTextResponse(result.body));
}

  if (route.family !== "compare") return respond(await c.notFound()); // registration/parser drift guard
  const page = parsePageNumber(url.searchParams.get("page"));
  const data = await loadCompareData(c.env, c.env.DB, repo, {
    base: route.base,
    head: route.head,
    headOwner: route.headOwner,
    headRepoName: route.headRepoName,
    separator: route.separator,
    viewer,
    page,
  });
  if ("notFound" in data) return respond(c.html(renderNotFound(ctx), 404));
  // The pulls-reader gate (upstream GET: the template's `.IsSigned` arm over
  // allowCreatePull's CanReadIssuesOrPulls(true), compare.go:305 — the
  // signed-in fork-PR author's own shape; the read grant itself is the
  // prologue's resolveRepositoryForViewer, satisfied by reaching this line).
  const canCreate =
    !repo.isArchived &&
    viewer.kind === "user" &&
    data.baseKind === "branch" &&
    data.headKind === "branch";
  return respond(
    c.html(
      renderComparePage({
        ctx,
        data,
        form: { title: data.suggestedTitle, content: data.suggestedContent },
        error: null,
        canCreate,
        page,
      }),
      200,
    ),
  );
}

// ---------------------------------------------------------------------------
// Window-2e C1: the global inbox pages (pages/global-inbox.tsx) — reqSignIn
// (web.go:567-573): anonymous 303s onto the login round-trip.
// ---------------------------------------------------------------------------

async function globalInboxIssuesPage(c: Context<{ Bindings: Env }>, listKind: "issues" | "pulls"): Promise<Response> {
  const resolved = await resolveUiSession(c);
  if (!resolved.ok) return resolved.response;
  const { url, viewer, respond } = resolved;
  const family = listKind === "issues" ? "global-issues" : "global-pulls";
  if (resolved.route.family !== family) return respond(await c.notFound()); // drift guard
  if (viewer.kind === "anonymous") return respond(loginRedirect(url.pathname + url.search));
  const data = await loadOverviewIssuesData(c.env.DB, viewer, listKind, url.searchParams);
  return respond(c.html(renderOverviewIssuesPage(resolved.ctx, data), 200));
}

async function globalMilestonesPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiSession(c);
  if (!resolved.ok) return resolved.response;
  const { url, viewer, respond } = resolved;
  if (resolved.route.family !== "global-milestones") return respond(await c.notFound()); // drift guard
  if (viewer.kind === "anonymous") return respond(loginRedirect(url.pathname + url.search));
  const data = await loadDashboardMilestonesData(c.env.DB, viewer, url.searchParams);
  return respond(c.html(renderDashboardMilestonesPage(resolved.ctx, data), 200));
}

/** Window-2e C3b: the subscriptions/watching tails (GET-only, reqSignIn —
 *  web.go:1786-1787; one upstream template dispatched on its Status key). */
async function notificationSubscriptionsPage(c: Context<{ Bindings: Env }>, watching: boolean): Promise<Response> {
  const resolved = await resolveUiSession(c);
  if (!resolved.ok) return resolved.response;
  const { url, ctx, viewer, respond } = resolved;
  const family = watching ? "notification-watching" : "notification-subscriptions";
  if (resolved.route.family !== family) return respond(await c.notFound()); // drift guard
  if (viewer.kind === "anonymous") return respond(loginRedirect(url.pathname + url.search));
  const data = watching
    ? await loadWatchingData(c.env.DB, viewer, url.searchParams)
    : await loadSubscriptionsData(c.env.DB, viewer, url.searchParams);
  return respond(c.html(renderNotificationSubscriptionsPage(ctx, data), 200));
}

// ---------------------------------------------------------------------------
// Window-2e C2: the WIKI family (pages/repo-wiki.tsx). The hasWiki gate
// 404-shells disabled wikis (the module handoff); the ?action= form value
// dispatches the sub-pages (the VERIFIED grammar — _pages/_revision are
// FORM-VALUE case-arms in wiki.go, not routes); writes carry sameOriginGuard
// + the writer gate + the archived refusal.
// ---------------------------------------------------------------------------

/** The wiki prologue: repo read, hasWiki gate, and the write-grant pair. */
async function wikiPrologue(
  c: Context<{ Bindings: Env }>,
): Promise<
  | {
      ok: true;
      ctx: UiContext;
      pair: NonNullable<Awaited<ReturnType<typeof findRepositoryById>>>;
      repo: RepoRow;
      rawTail: string;
      canWrite: boolean;
      doer: WikiDoer;
      respond: (r: Response, status?: number) => Response;
    }
  | { ok: false; response: Response }
> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return { ok: false, response: resolved.response };
  const { ctx, repo, viewer, respond } = resolved;
  if (resolved.route.family !== "wiki") return { ok: false, response: respond(await c.notFound()) }; // drift guard
  const settings = await loadRepoSettings(c.env.DB, repo.id);
  if (!settings.hasWiki) return { ok: false, response: respond(c.html(renderNotFound(ctx), 404)) };
  const pair = await findRepositoryById(c.env.DB, repo.id);
  if (pair === null) return { ok: false, response: respond(c.html(renderNotFound(ctx), 404)) };
  if (viewer.kind !== "user") {
    return { ok: true, ctx, pair, repo, rawTail: resolved.route.rawTail, canWrite: false, doer: { name: "", email: "" }, respond };
  }
  // The commit identity (the editor family's convention: stored email or
  // the noreply fallback).
  const userRow = await drizzle(c.env.DB).select().from(users).where(eq(users.id, viewer.id)).get();
  if (userRow === undefined) return { ok: false, response: respond(c.html(renderNotFound(ctx), 404)) };
  const email = userRow.email === null || userRow.email === "" ? `${userRow.username}@noreply.${new URL(c.req.url).hostname}` : userRow.email;
  return {
    ok: true,
    ctx,
    pair,
    repo,
    rawTail: resolved.route.rawTail,
    canWrite: !repo.isArchived && (await canWriteRepo(c.env, repo, viewer)),
    doer: { name: userRow.username, email },
    respond,
  };
}

async function wikiPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const p = await wikiPrologue(c);
  if (!p.ok) return p.response;
  const { ctx, pair, rawTail, canWrite, respond } = p;
  const url = new URL(c.req.url);
  const action = url.searchParams.get("action");
  if (action === "_pages") {
    const data = await loadWikiPagesData(c.env, pair);
    if (data.outcome === "no-wiki") return respond(c.html(renderWikiStartPage({ ctx, canWrite }), 200));
    return respond(c.html(renderWikiPagesPage({ ctx, data, canWrite }), 200));
  }
  if (action === "_revision") {
    const data = await loadWikiRevisionData(c.env, pair, rawTail, url.searchParams.get("page"));
    if (data.outcome === "start") return respond(c.html(renderWikiStartPage({ ctx, canWrite }), 200));
    if (data.outcome === "missing") {
      return respond(new Response(null, { status: 303, headers: { location: wikiPagesAction(p.repo) } }));
    }
    return respond(c.html(renderWikiRevisionPage({ ctx, data }), 200));
  }
  if (action === "_new") {
    if (!canWrite) return respond(c.html(renderNotFound(ctx), 404));
    return respond(c.html(renderWikiNewPage({ ctx, initialTitle: "", error: null }), 200));
  }
  if (action === "_edit") {
    if (!canWrite) return respond(c.html(renderNotFound(ctx), 404));
    const data = await loadWikiEditData(c.env, pair, rawTail, url.origin);
    if (data.outcome === "no-wiki") return respond(c.html(renderWikiStartPage({ ctx, canWrite }), 200));
    if (data.outcome === "missing") {
      return respond(new Response(null, { status: 303, headers: { location: wikiPagesAction(p.repo) } }));
    }
    return respond(c.html(renderWikiEditPage({ ctx, data, error: null }), 200));
  }
  const data = await loadWikiViewData(c.env, pair, rawTail, url.origin);
  if (data.outcome === "start") return respond(c.html(renderWikiStartPage({ ctx, canWrite }), 200));
  if (data.outcome === "missing") {
    return respond(new Response(null, { status: 303, headers: { location: wikiPagesAction(p.repo) } }));
  }
  return respond(c.html(renderWikiViewPage({ ctx, data, canWrite }), 200));
}

function wikiPagesAction(repo: RepoRow): string {
  return `${repoLinkOf(repo)}/wiki/?action=_pages`;
}

async function wikiSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const p = await wikiPrologue(c);
  if (!p.ok) return p.response;
  const { ctx, pair, rawTail, canWrite, doer, repo, respond } = p;
  if (!canWrite) return respond(c.html(renderNotFound(ctx), 404));
  const url = new URL(c.req.url);
  const form = parseWikiPageForm(await readUrlEncodedForm(c.req.raw));
  const action = url.searchParams.get("action");
  try {
    if (action === "_new") {
      const page = await createWikiPageFromForm(c.env, pair, doer, form, url.origin);
      return respond(new Response(null, { status: 303, headers: { location: `${repoLinkOf(repo)}/wiki/${page.sub_url}` } }));
    }
    if (action === "_delete") {
      await deleteWikiPageFromForm(c.env, pair, doer, rawTail);
      return respond(new Response(null, { status: 303, headers: { location: wikiPagesAction(repo) } }));
    }
    const page = await editWikiPageFromForm(c.env, pair, doer, rawTail, form, url.origin);
    return respond(new Response(null, { status: 303, headers: { location: `${repoLinkOf(repo)}/wiki/${page.sub_url}` } }));
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    // The service's exact validation texts re-render the form (the family
    // convention); the wiki's own edit/new arms.
    if (action === "_new") {
      return respond(c.html(renderWikiNewPage({ ctx, initialTitle: form.title, error: error.message }), 200));
    }
    const data = await loadWikiEditData(c.env, pair, rawTail, url.origin);
    if (data.outcome !== "edit") {
      return respond(new Response(null, { status: 303, headers: { location: wikiPagesAction(repo) } }));
    }
    return respond(c.html(renderWikiEditPage({ ctx, data, error: error.message }), 200));
  }
}
/**
 * POST /{owner}/{repo}/compare/{base}...{head} (upstream
 * CompareAndPullRequestPost, routers/web/repo/pull.go:1318, over the landed
 * create route's arms): the §2.8 Origin guard, the repo→viewer order, the
 * PULLS-READER gate (upstream's chain web.go:1312 `reqSignIn,
 * RepoMustNotBeArchived, reqUnitPullsReader` — reqUnitPullsReader is
 * RequireUnitReader(unit.TypePullRequests), web.go:933 +
 * services/context/permission.go:64-76, a 404 on the CANREAD miss; the
 * always-on pulls unit reads through the §2.5 grant the prologue already
 * ran, so the signed-in viewer passes and the archived arm 404-shells;
 * anonymous 303s onto the login round-trip — reqSignIn runs BEFORE the unit
 * check; the former `canWriteRepo` divergence is flipped — the fork-PR
 * author holds no write on the base), then the landed create arms in the API
 * route's order (head === base, no common history, equal tips, duplicate,
 * empty title) — every refusal re-renders the compare page at 200 with the
 * message and the submitted values (the login failure convention). Success
 * 303s onto the created PR's detail page (upstream JSONRedirect's
 * pullIssue.Link() target).
 */
async function compareSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const { url, ctx, viewer, repo, respond } = resolved;
  const route = resolved.route;
  // The bare URL carries no form (nothing to compare) — the registration
  // answers it with chi's 405; a null-side tail POST is hand-crafted (404).
  if (route.family !== "compare" || route.head === null) return respond(await c.notFound());
  if (viewer.kind === "anonymous") return respond(loginRedirect(url.pathname + url.search)); // reqSignIn (web.go:1312)
  // RepoMustNotBeArchived + reqUnitPullsReader (web.go:1312): the archived
  // arm 404-shells; the pulls-unit read is the §2.5 grant the prologue ran
  // (every signed-in viewer who sees the repo reads its pulls), so the
  // reader passes — the flipped writer gate.
  if (repo.isArchived) {
    return respond(c.html(renderNotFound(ctx), 404));
  }
  const doerRow = await drizzle(c.env.DB).select().from(users).where(eq(users.id, viewer.id)).get();
  if (doerRow === undefined) return respond(c.html(renderNotFound(ctx), 404)); // the session doer vanished
  const pair = await findRepositoryById(c.env.DB, repo.id);
  if (pair === null) return respond(c.html(renderNotFound(ctx), 404));
  const page = parsePageNumber(url.searchParams.get("page"));
  const data = await loadCompareData(c.env, c.env.DB, repo, {
    base: route.base,
    head: route.head,
    headOwner: route.headOwner,
    headRepoName: route.headRepoName,
    separator: route.separator,
    viewer,
    page,
  });
  if ("notFound" in data) return respond(c.html(renderNotFound(ctx), 404));
  const form = await readComparePullForm(c.req.raw);
  const result = await createPullFromForm({
    request: c,
    raw: c.req.raw,
    origin: url.origin,
    pair,
    repo,
    doer: doerRow,
    data,
    form,
  });
  const repoLink = `/${repo.ownerNamespace}/${repo.slug}`;
  if (result.outcome === "created") {
    return respond(new Response(null, { status: 303, headers: { location: `${repoLink}/pulls/${result.issue.index}` } }));
  }
  if (result.outcome === "failed") {
    // The head-ref write failed after the D1 commit — the rows are rolled
    // back, the retryable-unknown state answers the gate's plain-text 500.
    return new Response(`${result.message}\n`, {
      status: 500,
      headers: { "content-type": "text/plain;charset=utf-8", "x-content-type-options": "nosniff" },
    });
  }
  return respond(
    c.html(
      renderComparePage({
        ctx,
        data,
        form,
        error: result.message,
        canCreate: data.baseKind === "branch" && data.headKind === "branch",
        page,
      }),
      200,
    ),
  );
}

// ---------------------------------------------------------------------------
// The wave-18 commit-view family (pages/commit-view.tsx — upstream web.go
// :1739 repo.Diff, the parity survey's #1 dead-end)
// ---------------------------------------------------------------------------

/** GET /{owner}/{repo}/commit/{sha} (pages/commit-view.tsx): the commit
 *  header (title, identities, parents) + the diff over the landed
 *  `readCommit`/`readDiff` reads. Public anonymous like every read page;
 *  non-hex segments and unresolvable full oids 404-shell (upstream Diff's
 *  git.IsErrNotExist → ctx.NotFound arm). */
async function commitViewPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const { route, ctx, respond, repo } = resolved;
  if (route.family !== "commit-view") return respond(await c.notFound()); // registration/parser drift guard
  const data = await loadCommitViewData(c.env, c.env.DB, repo, route.sha);
  if ("notFound" in data) return respond(c.html(renderNotFound(ctx), 404));
  return respond(c.html(renderCommitViewPage({ ctx, data }), 200));
}

// ---------------------------------------------------------------------------
// The wave-29 diffpatch download family (pages/diffpatch-files.ts — the
// survey's row 4: upstream web.go:1760 repo.RawDiff + web.go:1657-1658
// DownloadPullDiff/Patch)
// ---------------------------------------------------------------------------

/**
 * GET /{owner}/{repo}/commit/{sha}.{diff|patch} +
 * GET /{owner}/{repo}/pulls/{index}.{diff|patch}: the raw-text downloads.
 * Upstream serves them from the web mux (no /api/v1 op): raw diff/patch
 * text with the sniffed text/plain content type and the context middleware's
 * zero-option prod Cache-Control (the module doc cites the arms). The
 * answer is not a page — the router returns the plain Response (the
 * tree-redirect precedent); the 404 family (missing/non-pull row, wrong-sha
 * shape, unresolvable oid — the short-prefix divergence) answers the §4.5
 * shell like upstream's ctx.NotFound.
 */
async function diffpatchFileDownload(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const { route, ctx, respond, repo } = resolved;
  if (route.family === "commit-diffpatch") {
    if (route.sha === undefined) return respond(await c.notFound()); // drift guard
    const body = await loadCommitDiffPatch(c.env, repo, route.sha, route.ext);
    if (body === null) return respond(c.html(renderNotFound(ctx), 404));
    return respond(diffPatchTextResponse(body));
  }
  if (route.family === "pull-diffpatch") {
    if (route.index === undefined) return respond(await c.notFound()); // drift guard
    const body = await loadPullDiffPatch(c, repo.id, route.index, route.ext);
    if (body === null) return respond(c.html(renderNotFound(ctx), 404));
    return respond(diffPatchTextResponse(body));
  }
  return respond(await c.notFound()); // drift guard
}

// ---------------------------------------------------------------------------
// The wave-32 archive download family (pages/archive-files.ts — the survey's
// row 1: upstream web.go:1689 repo.Download over
// services/repository/archiver)
// ---------------------------------------------------------------------------

/**
 * GET /{owner}/{repo}/archive/{ref}.{zip|tar.gz}: the streamed archive
 * download over the landed api/services/archive.ts builder (the API route's
 * composition). Upstream answers the octet-stream + nosniff pair, the weak
 * ETag/304 pair and the Nix immutable Link header (the module doc carries
 * the matrix); the 400 class (unknown suffix, the bundle refusal — the bare
 * `/archive` tail included) is http.Error's plain text, the 404 family
 * (empty repo, unresolvable ref) the §4.5 shell like every ui download.
 */
async function archiveFileDownload(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const { route, ctx, respond, repo, url } = resolved;
  if (route.family !== "repo-archive") return respond(await c.notFound()); // registration/parser drift guard
  const subPaths = (c.req.queries("path") ?? []).map((p) => p.replace(/^\/+|\/+$/g, "")).filter((p) => p !== "");
  const download = await loadRepoArchive(c.env, repo, route.refExt, subPaths);
  if (download.kind === "bad-format") return respond(archiveBadFormatResponse(download.message));
  if (download.kind === "not-found") return respond(c.html(renderNotFound(ctx), 404));
  return respond(
    repoArchiveResponse(download, {
      origin: url.origin,
      owner: repo.ownerNamespace,
      repo: repo.slug,
      ifNoneMatch: c.req.header("if-none-match") ?? null,
    }),
  );
}

// ---------------------------------------------------------------------------
// The wave-32 commit aux-JSON family (pages/commit-contained-refs.ts — the
// survey's row 3: upstream web.go:1740 repo.LoadBranchesAndTags)
// ---------------------------------------------------------------------------

/**
 * GET /{owner}/{repo}/commit/{sha}/load-branches-and-tags: the
 * ContainedLinks feed the official bundle's commit page fetches (the
 * branch/tag switcher dropdowns). Upstream answers ctx.JSON's
 * `application/json;charset=utf-8` with the middleware's zero-option prod
 * Cache-Control (the module doc cites the shape + the containment cost
 * posture); the 404 family (empty repo, wrong-shape/unresolvable sha — the
 * ServerError-500 divergence) answers the §4.5 shell.
 */
async function commitContainedRefsJson(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const { route, ctx, respond, repo } = resolved;
  if (route.family !== "commit-contained-refs") return respond(await c.notFound()); // drift guard
  const data = await loadCommitContainedRefs(c.env, repo, route.sha);
  if (data === null) return respond(c.html(renderNotFound(ctx), 404));
  return respond(containedRefsResponse(data));
}

// ---------------------------------------------------------------------------
// The wave-33 tags tails (pages/tag-list-aux.ts + pages/tags.tsx's
// applyTagDelete — the survey's top-5 #2: upstream web.go:1499 GetTagList +
// web.go:1501 DeleteTag)
// ---------------------------------------------------------------------------

/**
 * GET /{owner}/{repo}/tags/list (pages/tag-list-aux.ts — upstream GetTagList,
 * web.go:1499): the `{"results":[names]}` aux JSON for every viewer who can
 * see the repo; the group's MustBeNotEmpty (web.go:1500) 404-shells empty
 * repos before the load (the aux-JSON sibling of the wave-32 commit feed).
 */
async function tagListAuxJson(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const { route, ctx, respond, repo } = resolved;
  if (route.family !== "tags-list-aux") return respond(await c.notFound()); // drift guard
  if (repo.isEmpty) return respond(c.html(renderNotFound(ctx), 404)); // MustBeNotEmpty (web.go:1500's group gate)
  return respond(tagListResponse(await loadTagListAux(c.env, repo)));
}

// ---------------------------------------------------------------------------
// The wave-39 aux fragments (pages/tree-list-aux.ts +
// pages/branches-list-aux.ts — the survey's row 5: upstream web.go:1297-1306
// repo.TreeList + web.go:1695 repo.GetBranchesList; the tree-view,
// blob_excerpt and lastcommit fragments of the same row are documented
// skips — the module docs and the wave test header carry the cites)
// ---------------------------------------------------------------------------

/**
 * GET /{owner}/{repo}/tree-list/{branch|tag|commit}/* (pages/tree-list-aux.ts
 * — upstream TreeList, web.go:1297-1306): the recursive file-path array for
 * every viewer who can see the repo; the 404 family (empty repo — the
 * nil-Commit arm, unresolvable ref, failed walk) answers the §4.5 shell.
 */
async function treeListAuxJson(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const { route, ctx, respond, repo } = resolved;
  if (route.family !== "tree-list-aux") return respond(await c.notFound()); // drift guard
  const files = await loadTreeListAux(c.env, repo, route.refType, route.refSuffix);
  if (files === null) return respond(c.html(renderNotFound(ctx), 404));
  return respond(treeListResponse(files));
}

/**
 * GET /{owner}/{repo}/tree-view/{branch|tag|commit}/* (pages/tree-view-aux.ts
 * — upstream TreeViewNodes, web.go:1302-1306): the code-tree
 * `{fileTreeNodes, renderedIconPool}` envelope for every viewer who can see
 * the repo; the 404 family (empty repo — the nil-Commit arm, unresolvable
 * ref, missing treePath, failed walk) answers the §4.5 shell like the
 * tree-list twin. `?sub_path=` names the expansion chain (FormString at
 * treelist.go:149).
 */
async function treeViewAuxJson(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const { route, ctx, respond, repo } = resolved;
  if (route.family !== "tree-view-aux") return respond(await c.notFound()); // drift guard
  const envelope = await loadTreeViewNodes(c.env, repo, route.refType, route.refSuffix, c.req.query("sub_path") ?? "");
  if (envelope === null) return respond(c.html(renderNotFound(ctx), 404));
  return respond(treeViewResponse(envelope));
}

/**
 * GET /{owner}/{repo}/branches/list (pages/branches-list-aux.ts — upstream
 * GetBranchesList, web.go:1695): the `{"results":[names]}` aux JSON for every
 * viewer who can see the repo; the group's MustBeNotEmpty (web.go:1696)
 * 404-shells empty repos before the load (the wave-33 tags-list-aux twin).
 */
async function branchesListAuxJson(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const { route, ctx, respond, repo } = resolved;
  if (route.family !== "branches-list-aux") return respond(await c.notFound()); // drift guard
  if (repo.isEmpty) return respond(c.html(renderNotFound(ctx), 404)); // MustBeNotEmpty (web.go:1696's group gate)
  return respond(branchesListResponse(await loadBranchesListAux(c.env, repo)));
}

// ---------------------------------------------------------------------------
// The wave-41 releases download tail (pages/release-downloads.ts — the
// survey's top-5 #1: upstream web.go:1513 repo.GetAttachment + web.go:1514
// repo.RedirectDownload over the landed release-assets data)
// ---------------------------------------------------------------------------

/**
 * GET /{owner}/{repo}/releases/attachments/{uuid} and GET
 * /{owner}/{repo}/releases/download/{vTag}/{fileName}: the release-asset
 * binary serves (not pages). Upstream's group gates (web.go:1505-1514):
 * the §2.5 prologue answers the visibility arm, `releasesReadGate` the
 * MustBeNotEmpty + reqRepoReleaseReader pair (a disabled releases unit is
 * upstream CanRead(TypeReleases) false → 404), the module doc carries the
 * ServeAttachment/RedirectDownload ledger; the 404 family answers the §4.5
 * shell like every ui download.
 */
async function releaseDownloadTail(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const { route, ctx, respond, viewer, repo } = resolved;
  if (route.family !== "release-attachment" && route.family !== "release-download") {
    return respond(await c.notFound()); // registration/parser drift guard
  }
  if (!(await releasesReadGate(c.env.DB, repo))) return respond(c.html(renderNotFound(ctx), 404));
  // The draft gate's write arm (attachment.go:295-311's perm.CanWrite
  // (TypeReleases) — the same grant the releases pages render controls by).
  const canWriteReleases = await canWriteRepo(c.env, repo, viewer);
  let serve: ReleaseAttachmentServe;
  if (route.family === "release-download") {
    if (route.vTag === undefined || route.fileName === undefined) return respond(await c.notFound()); // drift guard
    serve = await loadReleaseDownload(c.env.REPO_PACKS, c.env.DB, repo, route.vTag, route.fileName, { canWriteReleases });
  } else {
    if (route.uuid === undefined) return respond(await c.notFound()); // drift guard
    serve = await openReleaseAttachment(c.env.REPO_PACKS, c.env.DB, repo, route.uuid, { canWriteReleases });
  }
  if (serve.kind === "not-found") return respond(c.html(renderNotFound(ctx), 404));
  return respond(
    releaseAttachmentResponse(serve, {
      ifNoneMatch: c.req.header("if-none-match") ?? null,
      ifModifiedSince: c.req.header("if-modified-since") ?? null,
    }),
  );
}

// ---------------------------------------------------------------------------
// The releases/tags feed twins (pages/releases-feed-xml.ts +
// pages/tags-feed-xml.ts — upstream web.go:1506-1507 + :1495-1496, the
// .rss/.atom channel bytes behind the repo header's feed links)
// ---------------------------------------------------------------------------

/** GET /{owner}/{repo}/releases.rss|.atom: the §2.5 prologue (visibility) →
 *  `releasesReadGate` (MustBeNotEmpty + the releases unit — web.go:1504's
 *  group gates; a disabled releases unit is upstream CanRead(TypeReleases)
 *  false → 404) → the loader (drafts excluded unconditionally — no viewer
 *  parameter, upstream's IncludeDrafts-unset) → the family's envelope.
 *  NO EnableFeed arm (the setting pins TRUE). */
async function releasesFeedRoute(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const { route, ctx, respond, repo, url } = resolved;
  if (route.family !== "release-feed-rss" && route.family !== "release-feed-atom") {
    return respond(await c.notFound()); // registration/parser drift guard
  }
  if (!(await releasesReadGate(c.env.DB, repo))) return respond(c.html(renderNotFound(ctx), 404));
  // The route clock (the seam at the top) flows into the channel Created
  // stamp — the loader's trailing `now` seam from the wallclock audit.
  const data = await loadReleasesFeedData(c.env.DB, repo, url.origin, routeNow());
  if (data === null) return respond(c.html(renderNotFound(ctx), 404)); // MustBeNotEmpty (web.go:1504)
  const body = route.family === "release-feed-rss" ? renderReleasesFeedRss(data) : renderReleasesFeedAtom(data);
  return respond(
    new Response(body, {
      headers: {
        "content-type": route.family === "release-feed-rss" ? RELEASES_FEED_CONTENT_TYPES.rss : RELEASES_FEED_CONTENT_TYPES.atom,
      },
    }),
  );
}

/** GET /{owner}/{repo}/tags.rss|.atom: the §2.5 prologue answers the group's
 *  reqUnitCodeReader (web.go:1502) — deliberately NO `releasesReadGate`
 *  (the tags group gates the code reader, not the releases reader), so a
 *  releases-disabled repo still serves tags.rss. The loader's only null arm
 *  IS the empty repo = MustBeNotEmpty. */
async function tagsFeedRoute(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const { route, ctx, respond, repo, url } = resolved;
  if (route.family !== "tags-feed-rss" && route.family !== "tags-feed-atom") {
    return respond(await c.notFound()); // registration/parser drift guard
  }
  // The route clock (the seam at the top) flows into the channel Created
  // stamp — the loader's trailing `now` seam from the wallclock audit.
  const data = await loadTagsFeedData(c.env, c.env.DB, repo, url.origin, routeNow());
  if (data === null) return respond(c.html(renderNotFound(ctx), 404)); // MustBeNotEmpty (web.go:1502)
  const body = route.family === "tags-feed-rss" ? renderTagsFeedRss(data) : renderTagsFeedAtom(data);
  return respond(
    new Response(body, {
      headers: {
        "content-type": route.family === "tags-feed-rss" ? TAGS_FEED_CONTENT_TYPES.rss : TAGS_FEED_CONTENT_TYPES.atom,
      },
    }),
  );
}

// ---------------------------------------------------------------------------
// The wave-41 rendered blob views (pages/render-files.ts — the survey's
// row 3: upstream web.go:1715-1719's /render group over repo.RenderFile)
// ---------------------------------------------------------------------------

/**
 * GET /{owner}/{repo}/render/{branch|tag|commit}/* and
 * GET /{owner}/{repo}/render/blob/{sha}: the standalone-page renders the
 * official bundle's external-render iframe fetches. The group's gates
 * (web.go:1653-1762's closing args + the subgroup's MustBeNotEmpty): the §2.5
 * prologue + the empty-repo 404 (the module doc carries the pipeline mapping
 * and the 400/404 family ledger).
 */
async function renderFileView(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const { route, ctx, respond, repo, url } = resolved;
  if (route.family !== "render-file") return respond(await c.notFound()); // drift guard
  let target: RenderFileTarget;
  if (route.sha !== undefined) target = { kind: "blob", sha: route.sha };
  else if (route.refType !== undefined && route.refSuffix !== undefined) {
    target = { kind: "ref", refType: route.refType, refSuffix: route.refSuffix };
  } else return respond(await c.notFound()); // drift guard
  const load = await loadRenderFile(c.env, repo, target, url.origin);
  if (load.kind === "not-found") return respond(c.html(renderNotFound(ctx), 404));
  if (load.kind === "no-renderer") return respond(renderNotAvailableResponse());
  return respond(renderFileResponse(load.html));
}

/**
 * GET /{owner}/{repo}/raw/{blob/{sha}|branch/*|tag/*|commit/*|*} and the
 * /media twins (pages/raw-files.ts — upstream web.go:1699-1713's two
 * groups): the §2.5 prologue + the empty-repo 404 (the group's
 * MustBeNotEmpty), then the pair re-read for the owner-visibility half of
 * the cache stamp (the wikiPrologue precedent), then the loader and the
 * byte builders (the module doc carries the ServeBlob matrix and the
 * divergence ledger).
 */
async function rawMediaFile(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const { route, ctx, respond, repo } = resolved;
  if (route.family !== "raw-file" && route.family !== "media-file") return respond(await c.notFound()); // drift guard
  let target: RawMediaTarget;
  if (route.sha !== undefined) target = { kind: "blob", sha: route.sha };
  else if (route.refType !== undefined && route.refSuffix !== undefined) {
    target = { kind: "ref", refType: route.refType, refSuffix: route.refSuffix };
  } else if (route.legacySuffix !== undefined) {
    target = { kind: "legacy", refSuffix: route.legacySuffix };
  } else return respond(await c.notFound()); // drift guard
  const pair = await findRepositoryById(c.env.DB, repo.id);
  if (pair === null) return respond(c.html(renderNotFound(ctx), 404));
  const cacheIsPublic = repo.visibility === "public" && pair.owner.visibility === "public";
  const ifNoneMatch = c.req.header("if-none-match") ?? null;
  const ifModifiedSince = c.req.header("if-modified-since") ?? null;
  if (route.family === "raw-file") {
    const load = await loadRawBlob(c.env, repo, target);
    if (load.kind === "not-found") return respond(c.html(renderNotFound(ctx), 404));
    return respond(rawBlobResponse(load, { cacheIsPublic, ifNoneMatch, ifModifiedSince }));
  }
  const load = await loadMediaBlob(c.env, repo, target);
  if (load.kind === "not-found") return respond(c.html(renderNotFound(ctx), 404));
  return respond(mediaBlobResponse(load, { cacheIsPublic, ifNoneMatch, ifModifiedSince }));
}

// ---------------------------------------------------------------------------
// The wave-46 fragment mounts (the machinery waves' routes — the survey
// row-5 skips landing: pages/repo-lastcommit-fragment.tsx's route handoff +
// pages/repo-blob-excerpt-fragment.tsx's stage 3)
// ---------------------------------------------------------------------------

/**
 * GET /{owner}/{repo}/lastcommit/* (pages/repo-lastcommit-fragment.tsx —
 * upstream web.go:1761's `RepoRefByType(RefTypeCommit)` + repo.LastCommit,
 * view.go:233-250): the directory-listing commit-info refresh the
 * `#repo-files-table` loader fetches. The handoff's arms, in order: the
 * §2.5 prologue (the code-read group's posture — the visibility resolution
 * covers reqUnitCodeReader, the render-file precedent); the tail parse
 * (parseLastCommitTail — the pattern miss 404-shells, upstream's
 * getRefNameFromPath ""); the loader's null family (the empty repo, an
 * unresolvable sha, a missing treePath — upstream's NotFound/ServerError
 * pair, both 404 here); then the standalone fragment Response with repoLink
 * `/${repo.ownerNamespace}/${repo.slug}`.
 */
async function lastCommitFragment(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const { route, ctx, respond, repo } = resolved;
  if (route.family !== "lastcommit") return respond(await c.notFound()); // registration/parser drift guard
  const tail = parseLastCommitTail(route.rawTail);
  if (tail === null) return respond(c.html(renderNotFound(ctx), 404)); // the route pattern's miss
  const data = await loadLastCommitFragment(c.env, repo, tail.commitRef, tail.treePath, c.req.query("refSubUrl") ?? "");
  if (data === null) return respond(c.html(renderNotFound(ctx), 404)); // the empty-repo/sha/treePath family
  return respond(lastCommitFragmentResponse(lastCommitFragmentHtml(data, `/${repo.ownerNamespace}/${repo.slug}`)));
}

/**
 * GET /{owner}/{repo}/blob_excerpt/{sha} and
 * GET /{owner}/{repo}/wiki/blob_excerpt/{sha} (pages/repo-blob-excerpt-
 * fragment.tsx — upstream web.go:1735 + web.go:1618's repo.ExcerptBlob,
 * compare.go:706-795): the hunk-window expansion rows the diff view's
 * expander buttons morph in. The group gates: the §2.5 prologue covers the
 * code-read (web.go:1653-1762's closing args) and the wiki twin's
 * reqUnitWikiReader; the wiki twin's MustEnableWiki (web.go:1614) reads the
 * landed repo-settings `hasWiki` (the wave-45 hasProjects precedent) — a
 * disabled wiki 404-shells. The rest rides the loader (the module doc
 * carries the knob-by-knob mapping and the 404 family): form parse → the
 * excerpt section → FileNameHash → the unified-arm fragment Response.
 */
async function blobExcerptFragment(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const { route, ctx, respond, repo } = resolved;
  if (route.family !== "blob-excerpt" && route.family !== "wiki-blob-excerpt") {
    return respond(await c.notFound()); // registration/parser drift guard
  }
  const wiki = route.family === "wiki-blob-excerpt";
  if (wiki) {
    const settings = await loadRepoSettings(c.env.DB, repo.id);
    if (!settings.hasWiki) return respond(c.html(renderNotFound(ctx), 404)); // MustEnableWiki (web.go:1614)
  }
  const form = parseBlobExcerptForm(resolved.url.searchParams);
  const load = await loadBlobExcerptSection(c.env, repo, route.sha, wiki, form);
  if (load === null) return respond(c.html(renderNotFound(ctx), 404)); // the empty/sha/path 404 family
  const repoLink = `/${repo.ownerNamespace}/${repo.slug}`;
  const html = blobExcerptFragmentHtml({
    section: load.section,
    fileNameHash: await hashFilePathForWebUI(load.filePath), // compare.go:792's FileNameHash
    baseLink: `${repoLink}${wiki ? "/wiki" : ""}/blob_excerpt`, // compare.go:719/729's BaseLink
    afterCommitID: route.sha, // compare.go:718's AfterCommitID — the path param verbatim
    style: form.style, // GetDiffViewStyle's resolved echo (middlewares.go:35-37)
  });
  return respond(blobExcerptFragmentResponse(html));
}

/** GET /{owner}/{repo}/wiki/raw/* (pages/wiki-raw.ts — web.go:1621's
 *  `m.Get("/raw/*", repo.WikiRaw)`): the §2.5 prologue (the wiki-reader
 *  visibility arm) → MustEnableWiki (web.go:1622 over the landed
 *  repo-settings `hasWiki`) → the pair re-read (the wikiPrologue precedent)
 *  → the loader (services/wiki's wiki cell) → the ServeBlob port. */
async function wikiRawBlob(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const { route, ctx, respond, repo } = resolved;
  if (route.family !== "wiki-raw") return respond(await c.notFound()); // drift guard
  const settings = await loadRepoSettings(c.env.DB, repo.id);
  if (!settings.hasWiki) return respond(c.html(renderNotFound(ctx), 404)); // MustEnableWiki (web.go:1622)
  const pair = await findRepositoryById(c.env.DB, repo.id);
  if (pair === null) return respond(c.html(renderNotFound(ctx), 404));
  const blob = await loadWikiRawBlob(c.env, pair, route.rawTail);
  if (blob === null) return respond(c.html(renderNotFound(ctx), 404)); // wiki.go:638's NotFound
  return respond(
    wikiRawBlobResponse(blob, {
      cacheIsPublic: repo.visibility === "public" && pair.owner.visibility === "public",
      ifNoneMatch: c.req.header("if-none-match") ?? null,
    }),
  );
}

/** The wave-33 tag delete's refusal shape — ctx.HTTPError(409, …)'s
 *  plain-text form (release.go:677-680 → base.go:105-113, the archive
 *  family's established answer), stamped with the web middleware's
 *  zero-option prod Cache-Control. */
function tagDeleteConflictResponse(): Response {
  return new Response(`${TAG_RELEASE_ATTACHED_MESSAGE}\n`, {
    status: 409,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "x-content-type-options": "nosniff",
      "cache-control": "max-age=0, private, must-revalidate",
    },
  });
}

/**
 * POST /{owner}/{repo}/tags/delete (pages/tags.tsx applyTagDelete — upstream
 * repo.DeleteTag → deleteReleaseOrTag(isDelTag=true), web.go:1501): the §2.8
 * Origin guard, the tags group's gates in upstream's order (MustBeNotEmpty →
 * RepoMustNotBeArchived → reqRepoCodeWriter; anonymous first — reqSignIn
 * precedes the group's optSignIn posture), then the write over the dual
 * carriers (the `id` D1-record key, the `tag` name arm for the rowless
 * engine tags — the TagRowView note). Every refusal answers upstream's
 * class: the release-attached 409 plain text, the missing id/tag the 404
 * shell; the flash outcomes 303 back onto the list with the branches
 * page's query-param convention (protected → tag_name_protected, failed →
 * the server-side text).
 */
async function tagsDeleteSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const { url, ctx, viewer, respond, repo } = resolved;
  if (resolved.route.family !== "tags-delete") return respond(await c.notFound()); // drift guard
  if (viewer.kind === "anonymous") return respond(loginRedirect(url.pathname + url.search)); // reqSignIn
  if (repo.isEmpty || repo.isArchived) return respond(c.html(renderNotFound(ctx), 404)); // MustBeNotEmpty + RepoMustNotBeArchived
  if (!(await canWriteRepo(c.env, repo, viewer))) return respond(c.html(renderNotFound(ctx), 404)); // reqRepoCodeWriter
  const subject = parseTagDeleteForm(await readUrlEncodedForm(c.req.raw));
  const doerRow = await drizzle(c.env.DB).select().from(users).where(eq(users.id, viewer.id)).get();
  if (doerRow === undefined) return respond(c.html(renderNotFound(ctx), 404)); // the session doer vanished
  const pair = await findRepositoryById(c.env.DB, repo.id);
  if (pair === null) return respond(c.html(renderNotFound(ctx), 404));
  let waitUntil: ((promise: Promise<unknown>) => void) | undefined;
  try {
    waitUntil = c.executionCtx.waitUntil.bind(c.executionCtx);
  } catch {
    waitUntil = undefined; // in-process test callers have no execution context
  }
  const result = await applyTagDelete(c.env, c.env.DB, repo, subject, {
    pair,
    doer: doerRow,
    origin: url.origin,
    waitUntil,
  });
  if (result.outcome === "release-attached") return respond(tagDeleteConflictResponse());
  if (result.outcome === "missing") return respond(c.html(renderNotFound(ctx), 404));
  const listPath = `/${repo.ownerNamespace}/${repo.slug}/tags`;
  const location =
    result.outcome === "deleted"
      ? `${listPath}?deleted=${encodeURIComponent(result.name)}`
      : `${listPath}?delete_error=${result.outcome === "refused-protected" ? "protected" : "failed"}&name=${encodeURIComponent(result.name)}`;
  return respond(new Response(null, { status: 303, headers: { location } }));
}

// ---------------------------------------------------------------------------
// The wave-33 releases edit/delete tails (pages/releases.tsx — the survey's
// top-5 #4: upstream web.go:1519-1520 EditRelease/EditReleasePost +
// web.go:1523 DeleteRelease under the write group)
// ---------------------------------------------------------------------------

/** The edit form's fixed meta (the stored row's tag pair + delete id) and
 *  prefill (release.go:579-590 — the stored values, tag_target's
 *  default-branch fallback). */
function editReleaseMetaOf(repo: RepoRow, row: { tagName: string; target: string | null; id: number }): {
  tagName: string;
  target: string;
  deleteId: number;
} {
  const storedTarget = row.target ?? "";
  return { tagName: row.tagName, target: storedTarget === "" ? repo.defaultBranch : storedTarget, deleteId: row.id };
}

/**
 * GET /{owner}/{repo}/releases/edit/{tag} (pages/releases.tsx — upstream
 * repo.EditRelease, web.go:1519): the writer-gated form (the write group's
 * releasesWriteGate), the stored values prefilled, the 404 arms first (a
 * missing row, a TAG-ONLY record — release.go:573-576's "pure tag" arm).
 */
async function releaseEditPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const gate = await releasesWriteGate(c, resolved);
  if (gate !== null) return gate;
  const { ctx, respond, repo } = resolved;
  const route = resolved.route;
  if (route.family !== "release-edit" || route.tag === undefined) return respond(await c.notFound()); // drift guard
  const row = await loadEditReleaseData(c.env.DB, repo.id, route.tag);
  if (row === null) return respond(c.html(renderNotFound(ctx), 404));
  const data = await loadNewReleaseData(c.env, repo);
  return respond(
    c.html(
      renderEditReleasePage({
        ctx,
        data,
        form: {
          tagName: row.tagName,
          tagTarget: row.target ?? "",
          title: row.title,
          content: row.note ?? "",
          draft: row.isDraft,
          prerelease: row.isPrerelease,
        },
        error: null,
        edit: editReleaseMetaOf(repo, row),
      }),
      200,
    ),
  );
}

/**
 * POST /{owner}/{repo}/releases/edit/{tag} (upstream EditReleasePost,
 * web.go:1520): the §2.8 Origin guard, the write gate, the row resolved by
 * the URL's tag (the PathParam the form's hidden pair never overrides), then
 * editReleaseFromForm — success 303s onto the LIST (upstream JSONRedirect's
 * exact target), the failures re-render at 200 with the message and the
 * kept submission (the login failure convention).
 */
async function releaseEditSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const gate = await releasesWriteGate(c, resolved);
  if (gate !== null) return gate;
  const { url, ctx, viewer, respond, repo } = resolved;
  const route = resolved.route;
  if (route.family !== "release-edit" || route.tag === undefined) return respond(await c.notFound()); // drift guard
  if (viewer.kind !== "user") return respond(c.html(renderNotFound(ctx), 404)); // the gate above admitted only users
  const row = await loadEditReleaseData(c.env.DB, repo.id, route.tag);
  if (row === null) return respond(c.html(renderNotFound(ctx), 404));
  const doerRow = await drizzle(c.env.DB).select().from(users).where(eq(users.id, viewer.id)).get();
  if (doerRow === undefined) return respond(c.html(renderNotFound(ctx), 404)); // the session doer vanished
  const pair = await findRepositoryById(c.env.DB, repo.id);
  if (pair === null) return respond(c.html(renderNotFound(ctx), 404));
  const form = parseEditReleaseForm(await readUrlEncodedForm(c.req.raw));
  const result = await editReleaseFromForm({
    env: c.env,
    request: c,
    repo,
    pair,
    doer: doerRow,
    row,
    form,
    origin: url.origin,
  });
  if (result.outcome === "updated") {
    return respond(new Response(null, { status: 303, headers: { location: `/${repo.ownerNamespace}/${repo.slug}/releases` } }));
  }
  const data = await loadNewReleaseData(c.env, repo);
  return respond(
    c.html(
      renderEditReleasePage({
        ctx,
        data,
        form: { tagName: row.tagName, tagTarget: row.target ?? "", ...form },
        error: result.message,
        edit: editReleaseMetaOf(repo, row),
      }),
      200,
    ),
  );
}

/**
 * POST /{owner}/{repo}/releases/delete (upstream DeleteRelease,
 * web.go:1523): the write gate, then deleteReleaseFromForm over the form's
 * `id` (the edit page's red button carrier) — success 303s onto the list
 * with the ?deleted= flash (upstream JSONRedirect + deletion_success's
 * flash), a missing id 404-shells (upstream NotFound).
 */
async function releaseDeleteSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const gate = await releasesWriteGate(c, resolved);
  if (gate !== null) return gate;
  const { url, ctx, viewer, respond, repo } = resolved;
  if (resolved.route.family !== "release-delete") return respond(await c.notFound()); // drift guard
  if (viewer.kind !== "user") return respond(c.html(renderNotFound(ctx), 404)); // the gate above admitted only users
  const id = parseReleaseDeleteForm(await readUrlEncodedForm(c.req.raw));
  if (id === null) return respond(c.html(renderNotFound(ctx), 404));
  const doerRow = await drizzle(c.env.DB).select().from(users).where(eq(users.id, viewer.id)).get();
  if (doerRow === undefined) return respond(c.html(renderNotFound(ctx), 404)); // the session doer vanished
  const pair = await findRepositoryById(c.env.DB, repo.id);
  if (pair === null) return respond(c.html(renderNotFound(ctx), 404));
  const result = await deleteReleaseFromForm({
    env: c.env,
    request: c,
    repo,
    pair,
    doer: doerRow,
    id,
    origin: url.origin,
  });
  if (result.outcome === "missing") return respond(c.html(renderNotFound(ctx), 404));
  return respond(
    new Response(null, {
      status: 303,
      headers: { location: `/${repo.ownerNamespace}/${repo.slug}/releases?deleted=${encodeURIComponent(result.name)}` },
    }),
  );
}

// ---------------------------------------------------------------------------
// The wave-20 releases family (pages/releases.tsx — upstream's web.go:1505-
// 1527 group at the landed api/services/releases.ts + release-assets.ts
// reads and the SPEC-0005 create arm)
// ---------------------------------------------------------------------------

/**
 * The releases family's read gate (upstream's group middleware verbatim):
 * `repo.MustBeNotEmpty` — an empty repo 404-shells the whole family — and
 * the releases unit gate (the API family's `mustEnableUnit` posture, the
 * routes' runtime 412; a page answers the invisible §4.5 shell).
 */
async function releasesReadGate(db: D1Database, repo: RepoRow): Promise<boolean> {
  if (repo.isEmpty) return false;
  return (await loadRepoSettings(db, repo.id)).hasReleases;
}

/** The form routes' gate (upstream's write group): the read gate plus
 *  `context.RepoMustNotBeArchived()` — archived repos 404-shell (the
 *  file-editor reduction of upstream's 403) — and the release-write grant
 *  (`reqRepoReleaseWriter` → canWriteRepo; anonymous already went to the
 *  login 303 before this check). */
async function releasesWriteGate(
  c: Context<{ Bindings: Env }>,
  resolved: Extract<ResolvedUiRequest, { ok: true }>,
): Promise<Response | null> {
  const { url, ctx, viewer, repo, respond } = resolved;
  if (viewer.kind === "anonymous") return respond(loginRedirect(url.pathname + url.search));
  if (repo.isArchived || !(await releasesReadGate(c.env.DB, repo))) {
    return respond(c.html(renderNotFound(ctx), 404));
  }
  if (!(await canWriteRepo(c.env, repo, viewer))) return respond(c.html(renderNotFound(ctx), 404));
  return null;
}

/** GET /{owner}/{repo}/releases (pages/releases.tsx — upstream repo.Releases,
 *  web.go:1506): the list for every viewer who can see the repo; drafts ride
 *  the write grant (upstream IncludeDrafts: writeAccess) and the New Release
 *  button the create grant (`CanCreateRelease` = write && !archived). */
async function releasesPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const { url, ctx, viewer, respond, repo } = resolved;
  if (!(await releasesReadGate(c.env.DB, repo))) return respond(c.html(renderNotFound(ctx), 404));
  const canWrite = await canWriteRepo(c.env, repo, viewer);
  const data = await loadReleasesData(c.env, c.env.DB, repo, canWrite, url.searchParams, url.origin);
  data.canCreate = canWrite;
  // The wave-33 delete write's flash params (the tags page's wave-33
  // convention — the POST 303s back with ?deleted=; display-only).
  return respond(
    c.html(
      renderReleasesPage(ctx, data, {
        deleted: url.searchParams.get("deleted"),
        errorKind: url.searchParams.get("delete_error"),
        errorName: url.searchParams.get("name") ?? "",
      }),
      200,
    ),
  );
}

/** GET /{owner}/{repo}/releases/new (pages/releases.tsx — upstream
 *  repo.NewRelease, web.go:1517): the writer-gated create form. The `?tag=`
 *  query prefills the tag-name field (wave 25 — the tags page's per-row
 *  "New Release" links carry it, upstream tags list.tmpl's exact shape). */
async function releaseNewPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const gate = await releasesWriteGate(c, resolved);
  if (gate !== null) return gate;
  const { url, ctx, respond, repo } = resolved;
  const data = await loadNewReleaseData(c.env, repo);
  return respond(
    c.html(
      renderNewReleasePage({
        ctx,
        data,
        form: {
          tagName: (url.searchParams.get("tag") ?? "").trim().slice(0, 255),
          tagTarget: "",
          title: "",
          content: "",
          draft: false,
          prerelease: false,
        },
        error: null,
      }),
      200,
    ),
  );
}

/**
 * POST /{owner}/{repo}/releases/new (upstream NewReleasePost, web.go:1518):
 * the §2.8 Origin guard, then the same gate order as the GET, then the
 * landed create arm through createReleaseFromForm (pages/releases.tsx — the
 * API POST route's service call + webhook sequence). Success 303s onto the
 * created release's DETAIL page (the task brief, the new-issue POST
 * convention — upstream JSONRedirects onto the list, the module header's
 * note); validation failures re-render the form at 200 with the message and
 * the kept submission (the login failure convention).
 */
async function releaseNewSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const gate = await releasesWriteGate(c, resolved);
  if (gate !== null) return gate;
  const { url, ctx, viewer, respond, repo } = resolved;
  if (viewer.kind !== "user") return respond(c.html(renderNotFound(ctx), 404)); // the gate above admitted only users
  const form = parseNewReleaseForm(await readUrlEncodedForm(c.req.raw));
  const pair = await findRepositoryById(c.env.DB, repo.id);
  if (pair === null) return respond(c.html(renderNotFound(ctx), 404));
  const doer = await drizzle(c.env.DB).select().from(users).where(eq(users.id, viewer.id)).get();
  if (doer === undefined) return respond(c.html(renderNotFound(ctx), 404)); // the session doer vanished
  const data = await loadNewReleaseData(c.env, repo);
  const result = await createReleaseFromForm({
    env: c.env,
    request: c,
    repo,
    pair,
    doer,
    form,
    branches: data.branches,
    origin: url.origin,
  });
  if (result.outcome === "created") {
    return respond(
      new Response(null, {
        status: 303,
        headers: {
          location: `/${repo.ownerNamespace}/${repo.slug}/releases/tag/${pathEscapeSegments(result.tag)}`,
        },
      }),
    );
  }
  return respond(c.html(renderNewReleasePage({ ctx, data, form, error: result.message }), 200));
}

/**
 * GET /{owner}/{repo}/releases/latest (upstream repo.LatestRelease,
 * web.go:1510): 303 onto the latest stable release's detail page
 * (`ctx.Redirect(release.Link())` — the html_url shape); no stable release
 * 404-shells (upstream NotFound).
 */
async function releaseLatestRedirect(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const { ctx, respond, repo } = resolved;
  if (!(await releasesReadGate(c.env.DB, repo))) return respond(c.html(renderNotFound(ctx), 404));
  const tag = await latestReleaseTagOf(c.env.DB, repo.id);
  if (tag === null) return respond(c.html(renderNotFound(ctx), 404));
  return respond(
    new Response(null, {
      status: 303,
      headers: { location: `/${repo.ownerNamespace}/${repo.slug}/releases/tag/${pathEscapeSegments(tag)}` },
    }),
  );
}

/**
 * GET /{owner}/{repo}/releases/tag/{tag} (upstream repo.SingleRelease,
 * web.go:1509): ONE release rendered through the same list entry — the
 * landed read's exact visibility rules (tag-only records and foreign-eye
 * drafts 404); the header menu shows the write-aware repo total (the
 * `NumReleases` the shared template renders).
 */
async function releaseDetailPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const { url, ctx, viewer, respond, repo } = resolved;
  if (!(await releasesReadGate(c.env.DB, repo))) return respond(c.html(renderNotFound(ctx), 404));
  const route = resolved.route;
  if (route.family !== "release-detail" || route.tag === undefined) return respond(await c.notFound()); // drift guard
  const canWrite = await canWriteRepo(c.env, repo, viewer);
  const entry = await loadReleaseDetailData(c.env, c.env.DB, repo, route.tag, canWrite, url.origin);
  if (entry === null) return respond(c.html(renderNotFound(ctx), 404));
  const { total } = await listReleases(c.env.DB, repo.id, {
    includeDrafts: canWrite,
    isDraft: null,
    isPrerelease: null,
    tagFilter: "",
    page: 1,
    limit: 1,
  });
  return respond(c.html(renderReleaseDetailPage({ ctx, entry, total }), 200));
}

/**
 * One handler for every claimed GET page family: the parser re-reads the
 * pathname (the route registrations below exist so the sub-app never claims
 * beyond the parser's families), the repo resolves through the §2.5
 * public-repo read, and the page switch renders (render.tsx delegates per
 * family). All routes are GET-only (§2.1); every unresolved repo/ref/path
 * answers the §4.5 404 shell, and a missing/unreadable manifest answers the
 * §2.3.4 503 before any page work happens.
 */
async function uiPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const { url, route, ctx, viewer, respond, repo } = resolved;

  // Wave-2 dispatch (render.tsx never sees these families). The redirect
  // and the list page run AFTER the same §2.5 repo resolution as the
  // slice-1 pages: unknown/private repos 404-shell, never redirect. Wave 41
  // adds ctx.Redirect's fetch-action arm to BOTH siblings (base.go:153-156 —
  // a non-empty X-Gitea-Fetch-Action header answers 200 {"redirect": …}
  // instead of the 303).
  if (route.family === "tree") {
    // Bare /tree has no upstream route (chi needs the slash) → §4.5 shell.
    if (route.rawSuffix === "") return respond(c.html(renderNotFound(ctx), 404));
    // The target prefix is the RESOLVED row's canonical link (upstream
    // ctx.Repo.RepoLink); the suffix and query travel verbatim.
    const repoLink = `/${repo.ownerNamespace}/${repo.slug}`;
    return respond(treeRedirectResponse(repoLink, route.rawSuffix, url.search, isFetchActionRequest(c.req.raw)));
  }
  // Wave-39: the blob-redirect twin (upstream RedirectRepoBlobToCommit —
  // the redirect runs AFTER the repository resolves exactly like the tree
  // family: unknown/private repos 404-shell, never redirect; the bare
  // /blob has no upstream route → §4.5 shell; the wave-41 fetch-action arm
  // rides the same header check).
  if (route.family === "blob-redirect") {
    if (route.rawSuffix === "") return respond(c.html(renderNotFound(ctx), 404));
    const repoLink = `/${repo.ownerNamespace}/${repo.slug}`;
    return respond(blobRedirectResponse(repoLink, route.rawSuffix, url.search, isFetchActionRequest(c.req.raw)));
  }
  if (route.family === "issues" || route.family === "pulls") {
    const data = await loadIssuesListData(c.env.DB, repo.id, route.family, url.searchParams);
    return respond(c.html(renderIssuesListPage(ctx, data), 200));
  }
  // Wave-3 dispatch: the issue/PR detail page (render.tsx never sees this
  // family). Upstream's type/URL match runs after the row lookup
  // (issue_view.go:347-352) — a mismatched family 303s onto Issue.Link(),
  // an unknown index 404-shells with the repo context (§4.5).
  if (route.family === "issue-detail") {
    const repoLink = `/${repo.ownerNamespace}/${repo.slug}`;
    const data = await loadIssueDetailData(c.env.DB, repo, route.urlKind, route.index, url.origin, viewer);
    if (data === null) return respond(c.html(renderNotFound(ctx), 404));
    const redirect = crossFamilyRedirect(route.urlKind, repoLink, data.issue.index, data.issue.isPull);
    if (redirect !== null) return respond(new Response(null, { status: 303, headers: { location: redirect } }));
    // Wave-5: the signed-in chrome (status button + admin label form) needs
    // the viewer's grants; anonymous resolves to the all-false access.
    const access = await resolveIssueDetailAccess(c.env, repo, resolved.viewer, data.issue);
    return respond(c.html(renderIssueDetailPage(ctx, data, access), 200));
  }
  // Wave-5 dispatch: the PR files diff view (render.tsx never sees this
  // family; non-pull rows 404-shell — pull-files.tsx header).
  if (route.family === "pull-files") {
    const data = await loadPullFilesData(c, repo.id, route.index);
    if (data === null) return respond(c.html(renderNotFound(ctx), 404));
    return respond(c.html(renderPullFilesPage({ ctx, data }), 200));
  }
  // The PR commits tab (render.tsx never sees this family; non-pull rows and
  // unresolvable base/head refs 404-shell — pull-commits.tsx header, the
  // upstream ViewPullCommits NotFound arm).
  if (route.family === "pull-commits") {
    const data = await loadPullCommitsData(c.env, repo, route.index, url.searchParams.get("page"));
    if (data === null) return respond(c.html(renderNotFound(ctx), 404));
    return respond(c.html(renderPullCommitsPage({ ctx, data }), 200));
  }
  // Wave-18 dispatch: the commit view (render.tsx never sees this family;
  // non-hex segments and unresolvable full oids 404-shell — the page
  // module's sha arms).
  if (route.family === "commit-view") {
    const data = await loadCommitViewData(c.env, c.env.DB, repo, route.sha);
    if ("notFound" in data) return respond(c.html(renderNotFound(ctx), 404));
    return respond(c.html(renderCommitViewPage({ ctx, data }), 200));
  }
  // The census R08 dispatch: the blame page (render.tsx never sees this
  // family). Every blame-unavailable posture (unresolvable ref, missing
  // path, binary, over-size/over-lines) is the loader's notFound → the
  // 404 shell — upstream RefBlame's NotFound arms (blame.go:48-51,77-85).
  if (route.family === "blame") {
    const data = await loadBlameData(
      engineClient(c.env, `${repo.ownerNamespace}/${repo.slug}`),
      repo,
      route.refSuffix,
    );
    if ("notFound" in data) return respond(c.html(renderNotFound(ctx), 404));
    return respond(c.html(renderBlamePage({ ctx, data }), 200));
  }
  // Wave-24 dispatch: the repo social lists (render.tsx never sees these
  // families; the loader's family switch picks the landed read — forks
  // through the viewer's reduced accessible-condition, stars/watchers
  // through the social lists).
  if (route.family === "forks" || route.family === "stars" || route.family === "watchers") {
    const data = await loadRepoSocialData(c.env.DB, repo, viewer, route.family, url.searchParams);
    return respond(c.html(renderRepoSocialPage(ctx, data), 200));
  }
  // Wave-25 dispatch: the tags listing (render.tsx never sees this family;
  // the engine ref universe read — the group's MustBeNotEmpty gate answers
  // the 404 shell for empty repos before the load).
  if (route.family === "tags") {
    if (repo.isEmpty) return respond(c.html(renderNotFound(ctx), 404)); // MustBeNotEmpty (web.go:1497's group gate)
    const page = parsePageNumber(url.searchParams.get("page"));
    const keyword = (url.searchParams.get("q") ?? "").slice(0, 255);
    const data = await loadTagsData(c.env, c.env.DB, repo, { page, keyword, viewer });
    // The wave-33 delete write's flash params (the branches page's
    // query-param convention — the POST 303s back with ?deleted=/
    // ?delete_error=; display-only).
    return respond(
      c.html(
        renderTagsPage({
          ctx,
          data,
          flash: {
            deleted: url.searchParams.get("deleted"),
            errorKind: url.searchParams.get("delete_error"),
            errorName: url.searchParams.get("name") ?? "",
          },
        }),
        200,
      ),
    );
  }

  // U3 page switch (render.tsx — home | commits | src), with the 404 shell
  // for unresolvable refs/paths (§4.5).
  if (!isSliceOneRoute(route)) return respond(await c.notFound()); // registration/parser drift guard
  const { status, html } = await renderUiPage({ env: c.env, ctx, route, url });
  return respond(c.html(html, status));
}

// ---------------------------------------------------------------------------
// The wave-23 org families (pages/org-members.tsx + pages/org-repos.tsx —
// upstream's /org/{org}/members literal web.go:965 and the
// /{username}/-/repositories route web.go:1134)
// ---------------------------------------------------------------------------

/** The org-family doer slice (the org-teams prologue's construction). */
function orgFamilyDoer(viewer: Viewer): { id: number | null; isAdmin: boolean } {
  return viewer.kind === "user" ? { id: viewer.id, isAdmin: viewer.isAdmin } : { id: null, isAdmin: false };
}

/** The org-family query string (resolveOrgForRequest's rename-redirect
 *  rewrite consumes it — the org-teams prologue's slice). */
function orgFamilyQuery(url: URL): string {
  return url.search.startsWith("?") ? url.search.slice(1) : url.search;
}

/**
 * GET /org/{org}/members (pages/org-members.tsx — the members list).
 * Anonymous-capable (upstream's group gate is RequireSignInViewStrict, off
 * at the pin): the org resolves through the org-home ladder (a plain user
 * name and an invisible org 404-shell, a rename 307s), the members
 * listing's PublicOnly scope is the per-row gate, and the owner prompt row
 * rides OrgAssignment's IsOwner composition (isOrgOwnerViewer).
 */
async function orgMembersPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiSession(c);
  if (!resolved.ok) return resolved.response;
  const { url, ctx, viewer, respond } = resolved;
  if (resolved.route.family !== "org-members") return respond(await c.notFound()); // drift guard
  const doer = orgFamilyDoer(viewer);
  const org = await resolveOrgMembersOrg(c.env.DB, resolved.route.owner, doer, url.pathname, orgFamilyQuery(url));
  if (org.kind === "redirect") {
    return respond(new Response(null, { status: 307, headers: { location: org.location } }));
  }
  if (org.kind === "missing") return respond(c.html(renderNotFound(ctx), 404));
  const ownerPrompt = await isOrgOwnerViewer(c.env.DB, org.org, viewer);
  const data = await loadOrgMembersData(c.env.DB, org.org, doer, url.searchParams);
  return respond(c.html(renderOrgMembersPage(ctx, data, { ownerPrompt }), 200));
}

/**
 * GET /{org}/-/repositories (pages/org-repos.tsx — the repositories family;
 * the org-home DOM through upstream's second URL). The same ladder: a plain
 * user name 404-shells (upstream org.Repositories' `org == nil` arm), a
 * renamed org 307s, an invisible org shells behind the shared 404. The
 * listing itself is the landed `listOrgRepositories` read (the §4.7
 * owner/team visibility arms decide the rows).
 */
async function orgRepositoriesPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiSession(c);
  if (!resolved.ok) return resolved.response;
  const { url, ctx, viewer, respond } = resolved;
  if (resolved.route.family !== "org-repositories") return respond(await c.notFound()); // drift guard
  const doer = orgFamilyDoer(viewer);
  const org = await resolveOrgRepositories(c.env.DB, resolved.route.owner, doer, url.pathname, orgFamilyQuery(url));
  if (org.kind === "redirect") {
    return respond(new Response(null, { status: 307, headers: { location: org.location } }));
  }
  if (org.kind === "missing") return respond(c.html(renderNotFound(ctx), 404));
  const data = await loadOrgRepositoriesData(c.env.DB, org.org, doer, url.searchParams);
  return respond(c.html(renderOrgRepositoriesPage(ctx, data), 200));
}

/**
 * GET /{owner}/-/projects (pages/owner-projects.tsx — the wave-37 projects
 * list; upstream's web.go:1143 read group over BOTH owner kinds). The
 * ladder: the org half (renamed orgs 307, invisible orgs 404-shell) gated
 * by orgProjectsAccessMode >= read (web.go:444-455), then the user half
 * (renamed users 307) gated by the individualPermsChecker ladder
 * (web.go:945-959 — private users answer to self or site admin only).
 * The listing rides the landed projects service — the doer-visibility-
 * filtered issue counts are the page's matrix.
 */
async function ownerProjectsPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiSession(c);
  if (!resolved.ok) return resolved.response;
  const { url, ctx, viewer, respond } = resolved;
  if (resolved.route.family !== "owner-projects") return respond(await c.notFound()); // drift guard
  const doer = orgFamilyDoer(viewer);
  const owner = await resolveOwnerProjects(c.env.DB, resolved.route.owner, doer, url.pathname, orgFamilyQuery(url));
  if (owner.kind === "redirect") {
    return respond(new Response(null, { status: 307, headers: { location: owner.location } }));
  }
  if (owner.kind === "missing") return respond(c.html(renderNotFound(ctx), 404));
  const data = await loadOwnerProjectsData(c.env.DB, owner, viewer, url.origin, url.searchParams);
  return respond(c.html(renderOwnerProjectsPage(ctx, data), 200));
}

// ---------------------------------------------------------------------------
// The SPEC-0016 M2 packages families (pages/packages.tsx — upstream's
// web.go:1109-1121 `/{username}/-` packages group [context.PackageAssignment
// + reqPackageAccess(read) fold into the resolution seam] and the R16
// web.go:1546 repo tab). The R04 subtree shares one prologue (the
// owner-projects list page's resolution shape: the quota gate → the gate
// ladder → rename-307 / invisible-404); every depth arm re-runs the SAME
// ladder, exactly upstream's group-wrap semantics.
// ---------------------------------------------------------------------------

/** The R04 families' drift guard — the shared prologue accepts exactly
 *  these (the list literal beside its four depth arms; each handler then
 *  narrows to its own family). */
function isOwnerPackagesRoute(route: ParsedUiRoute): route is OwnerPackagesRoute {
  return (
    route.family === "owner-packages" ||
    route.family === "owner-package-redirect" ||
    route.family === "owner-package-versions" ||
    route.family === "owner-package-version-view" ||
    route.family === "owner-package-file-download"
  );
}

/** The packages subtree's shared prologue: the global quota gate first
 *  (PACKAGES_ENABLED=false 404-shells the whole subtree — the profile
 *  tab's strict-polarity twin), then resolvePackagesOwner's gate ladder
 *  (a renamed owner 307s, an invisible one 404-shells — the org half's
 *  rename seam + the read-mode rank). */
async function resolveOwnerPackagesRequest(
  c: Context<{ Bindings: Env }>,
): Promise<
  | {
      ok: true;
      url: URL;
      ctx: UiContext;
      viewer: Viewer;
      respond: (res: Response) => Response;
      route: OwnerPackagesRoute;
      owner: PackagesOwner;
    }
  | { ok: false; response: Response }
> {
  const resolved = await resolveUiSession(c);
  if (!resolved.ok) return resolved;
  const { url, ctx, viewer, respond } = resolved;
  const route = resolved.route;
  if (!isOwnerPackagesRoute(route)) return { ok: false, response: await c.notFound() }; // drift guard
  if (ctx.packagesEnabled === false) return { ok: false, response: respond(c.html(renderNotFound(ctx), 404)) };
  const owner = await resolvePackagesOwner(c.env.DB, route.owner, orgFamilyDoer(viewer), url.pathname, orgFamilyQuery(url));
  if (owner.kind === "redirect") {
    return {
      ok: false,
      response: respond(new Response(null, { status: 307, headers: { location: owner.location } })),
    };
  }
  if (owner.kind === "missing") return { ok: false, response: respond(c.html(renderNotFound(ctx), 404)) };
  return { ok: true, url, ctx, viewer, respond, route, owner };
}

/** The resolved owner's id (the depth arms' owner-scoped reads — the page
 *  module's ownerIdOf seam, inlined: PackagesOwner carries exactly one id
 *  half per arm). */
function packagesOwnerIdOf(owner: PackagesOwner): number {
  return owner.kind === "org" ? owner.org.id : owner.user.id;
}

/** GET /{owner}/-/packages (pages/packages.tsx — the R04 list, upstream
 *  ListPackages web.go:1109): the latest-version-per-package rows over the
 *  gate-laddered owner. */
async function ownerPackagesPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveOwnerPackagesRequest(c);
  if (!resolved.ok) return resolved.response;
  const { url, ctx, viewer, respond, route, owner } = resolved;
  if (route.family !== "owner-packages") return respond(await c.notFound()); // drift guard
  const data = await loadOwnerPackagesData(c.env.DB, owner, viewer, url.origin, url.searchParams);
  return respond(c.html(renderOwnerPackagesPage(ctx, data), 200));
}

/** GET /{owner}/-/packages/{type}/{name} (upstream RedirectToLastVersion,
 *  package.go:137): the 303 onto the latest non-internal version's page; a
 *  package (or every-version) miss 404-shells. */
async function ownerPackageLatestRedirect(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveOwnerPackagesRequest(c);
  if (!resolved.ok) return resolved.response;
  const { ctx, respond, route, owner } = resolved;
  if (route.family !== "owner-package-redirect") return respond(await c.notFound()); // drift guard
  const latest = await resolveLatestVersionRedirect(
    c.env.DB,
    packagesOwnerIdOf(owner),
    route.type ?? "",
    route.name ?? "",
  );
  if (latest.kind === "missing") return respond(c.html(renderNotFound(ctx), 404));
  return respond(new Response(null, { status: 303, headers: { location: latest.location } }));
}

/** GET /{owner}/-/packages/{type}/{name}/versions (upstream
 *  ListPackageVersions, package.go:322): the joined version page; a
 *  package miss 404-shells (upstream's NotFound). */
async function ownerPackageVersionsPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveOwnerPackagesRequest(c);
  if (!resolved.ok) return resolved.response;
  const { url, ctx, viewer, respond, route, owner } = resolved;
  if (route.family !== "owner-package-versions") return respond(await c.notFound()); // drift guard
  const data = await loadOwnerPackageVersionsData(
    c.env.DB,
    owner,
    viewer,
    route.type ?? "",
    route.name ?? "",
    url.searchParams,
  );
  if (data === null) return respond(c.html(renderNotFound(ctx), 404));
  return respond(c.html(renderOwnerPackageVersionsPage(ctx, data), 200));
}

/** GET /{owner}/-/packages/{type}/{name}/{version} (upstream
 *  ViewPackageVersion, package.go:188): the version view; a null answer at
 *  either identity hop 404-shells. */
async function ownerPackageVersionViewPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveOwnerPackagesRequest(c);
  if (!resolved.ok) return resolved.response;
  const { url, ctx, viewer, respond, route, owner } = resolved;
  if (route.family !== "owner-package-version-view") return respond(await c.notFound()); // drift guard
  const data = await loadOwnerPackageVersionViewData(
    c.env.DB,
    owner,
    viewer,
    url.origin,
    route.type ?? "",
    route.name ?? "",
    route.version ?? "",
  );
  if (data === null) return respond(c.html(renderNotFound(ctx), 404));
  return respond(c.html(renderOwnerPackageVersionViewPage(ctx, data), 200));
}

/** GET /{owner}/-/packages/{type}/{name}/{version}/files/{fileid} (upstream
 *  DownloadPackageFile, package.go:530): the {version} segment is the
 *  identity hop (GetVersionByNameAndVersion), then the file pair arbitrates
 *  under it and the byte answer streams (the attachment disposition, the
 *  If-Modified-Since 304 — the release-downloads reduction). */
async function ownerPackageFileDownload(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveOwnerPackagesRequest(c);
  if (!resolved.ok) return resolved.response;
  const { ctx, respond, route, owner } = resolved;
  if (route.family !== "owner-package-file-download") return respond(await c.notFound()); // drift guard
  const versionRow = await getVersionByNameAndVersion(
    c.env.DB,
    packagesOwnerIdOf(owner),
    route.type ?? "",
    route.name ?? "",
    route.version ?? "",
  );
  if (versionRow === null) return respond(c.html(renderNotFound(ctx), 404));
  const download = await loadPackageFileDownload(
    c.env.REPO_PACKS,
    c.env.DB,
    versionRow.id,
    route.fileId ?? 0,
    "GET",
  );
  if (download.kind === "not-found") return respond(c.html(renderNotFound(ctx), 404));
  return respond(
    packageFileDownloadResponse(download, { ifModifiedSince: c.req.header("if-modified-since") ?? null }),
  );
}

/** GET /{owner}/{repo}/packages (pages/packages.tsx — the R16 tab, upstream
 *  repo.Packages web.go:1546): the repo-faceted list over the SAME
 *  latest-version rows. The `repo_settings.has_packages` toggle gates (the
 *  shell tab reads the SAME resolveUiRequest flag — the has_projects
 *  pattern), and the writer grant arms the empty-repo hint (the releases
 *  canCreate pattern). */
async function repoPackagesPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const { url, ctx, viewer, repo, respond } = resolved;
  if (resolved.route.family !== "repo-packages") return respond(await c.notFound()); // drift guard
  if (resolved.ctx.repoHasPackages !== true) return respond(c.html(renderNotFound(ctx), 404));
  const data = await loadRepoPackagesData(c.env.DB, repo, viewer, url.origin, url.searchParams);
  data.canWritePackages = await canWriteRepo(c.env, repo, viewer);
  return respond(c.html(renderRepoPackagesPage(ctx, data), 200));
}

// ---------------------------------------------------------------------------
// The wave-40 owner projects BOARD families (pages/owner-project-board.tsx —
// upstream's web.go:1140-1155 board view + write group + the web.go:327-345
// board/workflow helper POSTs). Every handler rides the LIST page's
// resolution (the read group gates), then the write group's ladder at the
// shared depth prologue + ownerProjectWriteGate.
// ---------------------------------------------------------------------------

/** The wave-40 families' guard — the depth prologue accepts exactly these
 *  (all carrying the board id). */
function isOwnerProjectBoardRoute(route: ParsedUiRoute): route is OwnerProjectBoardRoute {
  return (
    route.family === "owner-project-board" ||
    route.family === "owner-project-edit" ||
    route.family === "owner-project-delete" ||
    route.family === "owner-project-status" ||
    route.family === "owner-project-column-new" ||
    route.family === "owner-project-column-default" ||
    route.family === "owner-project-workflows" ||
    route.family === "owner-project-workflow-delete"
  );
}

/** The resolved projects depth: the read-gated owner + the owner-scoped
 *  project row + the parsed route (the `/-/projects/{id}` families only —
 *  `/new` resolves its owner inline). */
type ResolvedProjectDepth =
  | {
      ok: true;
      url: URL;
      ctx: UiContext;
      viewer: Viewer;
      respond: (res: Response) => Response;
      route: OwnerProjectBoardRoute;
      owner: ResolvedOwner;
      /** The owner's `/-/projects` list base (the list-landing 303 target). */
      ownerLink: string;
      project: ProjectRow;
    }
  | { ok: false; response: Response };

/** The owner's namespace segment (the list base's head). */
function ownerBase(owner: ResolvedOwner): string {
  return owner.kind === "org" ? owner.org.username : owner.user.username;
}

/**
 * The projects depth's shared prologue: the LIST page's resolution (the read
 * group — the org unit-access gate or the individualPermsChecker ladder, the
 * rename-307 seam included), then the owner-scoped project read
 * (GetProjectByIDAndOwner — another owner's id reads as not found). A
 * missing owner or project 404-shells.
 */
async function resolveOwnerProjectDepth(c: Context<{ Bindings: Env }>): Promise<ResolvedProjectDepth> {
  const resolved = await resolveUiSession(c);
  if (!resolved.ok) return resolved;
  const { url, ctx, viewer, respond, route } = resolved;
  if (!isOwnerProjectBoardRoute(route)) return { ok: false, response: await c.notFound() }; // drift guard
  const owner = await resolveOwnerProjects(c.env.DB, route.owner, boardDoer(viewer), url.pathname, orgFamilyQuery(url));
  if (owner.kind === "redirect") {
    return {
      ok: false,
      response: respond(new Response(null, { status: 307, headers: { location: owner.location } })),
    };
  }
  if (owner.kind === "missing") return { ok: false, response: respond(c.html(renderNotFound(ctx), 404)) };
  const project = await findOwnerProject(c.env.DB, owner, route.id ?? 0);
  if (project === null) return { ok: false, response: respond(c.html(renderNotFound(ctx), 404)) };
  return {
    ok: true,
    url,
    ctx,
    viewer,
    respond,
    route,
    owner,
    ownerLink: `/${ownerBase(owner)}/-/projects`,
    project,
  };
}

/**
 * The write group's gate (web.go:1146-1155, mounted inside the read group):
 * anonymous → the login 303 (reqSignIn), a signed-in non-writer → the 404
 * shell (reqAnyRepoUnitAccess(write, true) + the web.go:1151-1155 individual
 * check — canWriteProjects covers both, INCLUDING the site-admin-on-another-
 * user's-project arm). Returns the Response to answer, or null to proceed.
 */
function ownerProjectWriteGate(
  c: Context<{ Bindings: Env }>,
  depth: Extract<ResolvedProjectDepth, { ok: true }>,
): Promise<Response | null> {
  return ownerProjectWriteGateAt(
    c,
    depth.owner,
    depth.viewer,
    depth.ctx,
    depth.respond,
    depth.url.pathname + depth.url.search,
  );
}

/** The write gate's free-variable form (the /new handlers' inline owner). */
async function ownerProjectWriteGateAt(
  c: Context<{ Bindings: Env }>,
  owner: ResolvedOwner,
  viewer: Viewer,
  ctx: UiContext,
  respond: (res: Response) => Response,
  requestUri: string,
): Promise<Response | null> {
  if (viewer.kind === "anonymous") return respond(loginRedirect(requestUri));
  if (!(await ownerProjectWriteAccess(c.env.DB, owner, boardDoer(viewer)))) {
    return respond(c.html(renderNotFound(ctx), 404));
  }
  return null;
}

/** GET /{owner}/-/projects/{id} (org.ViewProject — the board). */
async function ownerProjectBoardPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const depth = await resolveOwnerProjectDepth(c);
  if (!depth.ok) return depth.response;
  const { url, ctx, viewer, respond, owner, project } = depth;
  const data = await loadProjectBoardData(c.env.DB, owner, project, viewer, url.origin, url.searchParams);
  return respond(c.html(renderProjectBoardPage({ ctx, data, columnForm: { title: "", color: "" }, columnError: null }), 200));
}

/** The /new handlers' shared prologue (no board id — the owner resolves
 *  inline through the LIST page's seam). */
type ResolvedOwnerEntry =
  | (Extract<Awaited<ReturnType<typeof resolveUiSession>>, { ok: true }> & { owner: ResolvedOwner })
  | { ok: false; response: Response };

async function resolveOwnerEntry(c: Context<{ Bindings: Env }>): Promise<ResolvedOwnerEntry> {
  const resolved = await resolveUiSession(c);
  if (!resolved.ok) return resolved;
  const { url, viewer, respond } = resolved;
  if (resolved.route.family !== "owner-project-new") return { ok: false, response: await c.notFound() }; // drift guard
  const owner = await resolveOwnerProjects(c.env.DB, resolved.route.owner, boardDoer(viewer), url.pathname, orgFamilyQuery(url));
  if (owner.kind === "redirect") {
    return { ok: false, response: respond(new Response(null, { status: 307, headers: { location: owner.location } })) };
  }
  if (owner.kind === "missing") return { ok: false, response: respond(c.html(renderNotFound(resolved.ctx), 404)) };
  return { ...resolved, owner };
}

/** GET /{owner}/-/projects/new (RenderNewProject — the write group's form;
 *  the write gate is the route group's, run before any render). */
async function ownerProjectNewPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const entry = await resolveOwnerEntry(c);
  if (!entry.ok) return entry.response;
  const { url, ctx, viewer, respond, owner } = entry;
  const gate = await ownerProjectWriteGateAt(c, owner, viewer, ctx, respond, url.pathname + url.search);
  if (gate !== null) return gate;
  const counts = await loadProjectChromeCounts(c.env.DB, owner, viewer);
  return respond(
    c.html(
      renderNewProjectPage({ ctx, owner, form: { title: "", content: "", templateType: "", cardType: "" }, error: null, counts }),
      200,
    ),
  );
}

/** POST /{owner}/-/projects/new (NewProjectPost): success 303s onto the
 *  LIST page, the binding failures re-render at 200 with the message and
 *  the kept submission. */
async function ownerProjectNewSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const entry = await resolveOwnerEntry(c);
  if (!entry.ok) return entry.response;
  const { url, ctx, viewer, respond, owner } = entry;
  const gate = await ownerProjectWriteGateAt(c, owner, viewer, ctx, respond, url.pathname + url.search);
  if (gate !== null) return gate;
  const doer = boardDoer(viewer);
  if (doer.id === null) return respond(c.html(renderNotFound(ctx), 404));
  const form = parseProjectForm(await readUrlEncodedForm(c.req.raw));
  const result = await createProjectFromForm(c.env.DB, owner, doer.id, form, new Date());
  if (result.outcome === "created") {
    return respond(new Response(null, { status: 303, headers: { location: `/${ownerBase(owner)}/-/projects` } }));
  }
  const counts = await loadProjectChromeCounts(c.env.DB, owner, viewer);
  return respond(c.html(renderNewProjectPage({ ctx, owner, form, error: result.message, counts }), 200));
}

/** GET /{owner}/-/projects/{id}/edit (RenderEditProject — the pre-filled
 *  form; `?redirect=project` rides the hidden field to the POST). */
async function ownerProjectEditPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const depth = await resolveOwnerProjectDepth(c);
  if (!depth.ok) return depth.response;
  const { url, ctx, viewer, respond, owner, project } = depth;
  const gate = await ownerProjectWriteGate(c, depth);
  if (gate !== null) return gate;
  const data = await loadProjectBoardData(c.env.DB, owner, project, viewer, url.origin, new URLSearchParams());
  return respond(
    c.html(
      renderEditProjectPage({
        ctx,
        data,
        form: {
          title: project.title,
          content: project.description,
          templateType: "",
          cardType: cardTypeToString(project.cardType),
        },
        error: null,
        redirect: url.searchParams.get("redirect") ?? "",
      }),
      200,
    ),
  );
}

/** POST /{owner}/-/projects/{id}/edit (EditProjectPost): success 303s onto
 *  the board when the form's hidden `redirect=project` rode (upstream's
 *  ctx.Redirect(p.Link())), else onto the LIST page; the binding failures
 *  re-render at 200. */
async function ownerProjectEditSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const depth = await resolveOwnerProjectDepth(c);
  if (!depth.ok) return depth.response;
  const { url, ctx, viewer, respond, owner, project } = depth;
  const gate = await ownerProjectWriteGate(c, depth);
  if (gate !== null) return gate;
  const formParams = await readUrlEncodedForm(c.req.raw);
  const form = parseProjectForm(formParams);
  const result = await updateProjectFromForm(c.env.DB, project, form, new Date());
  if (result.outcome === "updated") {
    const target =
      formParams.get("redirect") === "project" ? projectLinkOf(owner, project) : `/${ownerBase(owner)}/-/projects`;
    return respond(new Response(null, { status: 303, headers: { location: target } }));
  }
  const data = await loadProjectBoardData(c.env.DB, owner, project, viewer, url.origin, new URLSearchParams());
  return respond(
    c.html(
      renderEditProjectPage({
        ctx,
        data,
        form,
        error: result.message,
        redirect: formParams.get("redirect") ?? "",
      }),
      200,
    ),
  );
}

/** POST /{owner}/-/projects/{id}/delete (DeleteProject): the cascade delete
 *  then the 303 onto the LIST page (upstream's JSONRedirect target). */
async function ownerProjectDeleteSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const depth = await resolveOwnerProjectDepth(c);
  if (!depth.ok) return depth.response;
  const gate = await ownerProjectWriteGate(c, depth);
  if (gate !== null) return gate;
  await deleteProjectById(c.env.DB, depth.project.id);
  return depth.respond(new Response(null, { status: 303, headers: { location: `/${ownerBase(depth.owner)}/-/projects` } }));
}

/** POST /{owner}/-/projects/{id}/open|close (ChangeProjectStatus): the
 *  guarded flip then the 303 onto the board (upstream's JSONRedirect →
 *  ProjectLinkForOrg). */
async function ownerProjectStatusSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const depth = await resolveOwnerProjectDepth(c);
  if (!depth.ok) return depth.response;
  const gate = await ownerProjectWriteGate(c, depth);
  if (gate !== null) return gate;
  const action = depth.route.family === "owner-project-status" ? depth.route.action : undefined;
  if (action !== "open" && action !== "close") return depth.respond(await c.notFound());
  await changeProjectStatus(c.env.DB, depth.project, action === "close", new Date());
  return depth.respond(new Response(null, { status: 303, headers: { location: projectLinkOf(depth.owner, depth.project) } }));
}

/** POST /{owner}/-/projects/{id}/columns/new (AddColumnToProjectPost): the
 *  board re-renders at 200 with the message + the kept values on the
 *  binding/validation arms, 303s onto the board on success (upstream's
 *  JSONOK + JS reload). */
async function ownerProjectColumnNewSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const depth = await resolveOwnerProjectDepth(c);
  if (!depth.ok) return depth.response;
  const { url, ctx, viewer, respond, owner, project } = depth;
  const gate = await ownerProjectWriteGate(c, depth);
  if (gate !== null) return gate;
  if (viewer.kind !== "user") return respond(c.html(renderNotFound(ctx), 404));
  const form = parseColumnForm(await readUrlEncodedForm(c.req.raw));
  const result = await createColumnFromForm(c.env.DB, project, viewer.id, form, new Date());
  if (result.outcome === "created") {
    return respond(new Response(null, { status: 303, headers: { location: projectLinkOf(owner, project) } }));
  }
  const data = await loadProjectBoardData(c.env.DB, owner, project, viewer, url.origin, url.searchParams);
  return respond(c.html(renderProjectBoardPage({ ctx, data, columnForm: form, columnError: result.message }), 200));
}

/** POST /{owner}/-/projects/{id}/{columnID}/default (SetDefaultProjectColumn):
 *  a foreign column id 404-shells, success 303s onto the board. */
async function ownerProjectColumnDefaultSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const depth = await resolveOwnerProjectDepth(c);
  if (!depth.ok) return depth.response;
  const { ctx, respond, owner, project } = depth;
  const gate = await ownerProjectWriteGate(c, depth);
  if (gate !== null) return gate;
  const columnId = depth.route.family === "owner-project-column-default" ? depth.route.columnId : undefined;
  if (columnId === undefined) return respond(await c.notFound());
  const result = await setProjectDefaultColumnFromForm(c.env.DB, project, columnId, new Date());
  if (result.outcome === "missing") return respond(c.html(renderNotFound(ctx), 404));
  return respond(new Response(null, { status: 303, headers: { location: projectLinkOf(owner, project) } }));
}

/** The workflows prologue's shared tail: the ?workflow_id focus (an unknown
 *  id 404-shells — the slices.ContainsFunc arm), then the render (create
 *  form / focused edit form + the re-render error arm). The ?event
 *  validation is the GET handler's arm (the POST re-render must reach the
 *  page with the service's 422 message, never the 404 shell). */
async function workflowsReRender(
  c: Context<{ Bindings: Env }>,
  depth: Extract<ResolvedProjectDepth, { ok: true }>,
  form: WorkflowForm,
  error: string | null,
): Promise<Response> {
  const { url, ctx, viewer, respond, owner, project } = depth;
  const data = await loadProjectWorkflowsData(c.env.DB, owner, project, viewer, url.origin, url.searchParams);
  if (depth.route.workflowId !== undefined) {
    const focused = await findWorkflowByIdAndProject(c.env.DB, depth.route.workflowId, project.id);
    if (focused === null) return respond(c.html(renderNotFound(ctx), 404));
    data.workflowId = depth.route.workflowId;
  }
  return respond(c.html(renderProjectWorkflowsPage({ ctx, data, form, error }), 200));
}

/** The workflows rule form's empty create state (the GET's fresh form). */
function emptyWorkflowForm(event: string): WorkflowForm {
  return {
    event,
    enabled: true,
    enabledPresent: false,
    hasRuleFields: false,
    filters: { issue_type: "", source_column_id: 0, target_column_id: 0, label_ids: [] },
    actions: { column_id: 0, add_label_ids: [], remove_label_ids: [], issue_state: "" },
  };
}

/** GET /{owner}/-/projects/{id}/workflows[/{wid}] (org.ProjectWorkflows →
 *  RenderWorkflows) — the read group gates it; the edit arms ride canManage
 *  inside the render. An unknown `?event=` preselect 404-shells
 *  (RenderWorkflows' workflow.go:48-52 arm). */
async function ownerProjectWorkflowsPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const depth = await resolveOwnerProjectDepth(c);
  if (!depth.ok) return depth.response;
  const event = depth.url.searchParams.get("event");
  if (event !== null && event !== "" && !WORKFLOW_EVENTS.some((entry) => entry.event === event)) {
    return depth.respond(c.html(renderNotFound(depth.ctx), 404));
  }
  return workflowsReRender(c, depth, emptyWorkflowForm(event ?? ""), null);
}

/** The workflows writes' second-layer gate (CanManageWorkflows —
 *  workflow.go:27-48): a projects writer who is not the org owner / the
 *  user owner 404-shells (upstream answers the service's JSONError 403; the
 *  landed gate posture is the uniform not-found shell). */
async function ownerProjectManageGate(
  c: Context<{ Bindings: Env }>,
  depth: Extract<ResolvedProjectDepth, { ok: true }>,
): Promise<Response | null> {
  const writeGate = await ownerProjectWriteGate(c, depth);
  if (writeGate !== null) return writeGate;
  const doer = boardDoer(depth.viewer);
  const canManage =
    depth.owner.kind === "org"
      ? await canManageOrgProjectWorkflows(c.env.DB, depth.owner.org, { id: doer.id ?? 0, isAdmin: doer.isAdmin })
      : canManageUserProjectWorkflows(depth.project, { id: doer.id ?? 0 });
  if (!canManage) return depth.respond(c.html(renderNotFound(depth.ctx), 404));
  return null;
}

/** POST /{owner}/-/projects/{id}/workflows (CreateWorkflow): the service
 *  422s re-render at 200, success 303s onto the workflows page (upstream's
 *  JSON body + JS reload). */
async function ownerProjectWorkflowCreateSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const depth = await resolveOwnerProjectDepth(c);
  if (!depth.ok) return depth.response;
  const manageGate = await ownerProjectManageGate(c, depth);
  if (manageGate !== null) return manageGate;
  const form = parseWorkflowForm(await readUrlEncodedForm(c.req.raw));
  const result = await createWorkflowFromForm(c.env.DB, depth.owner, depth.project, form, new Date());
  if (result.outcome === "created") {
    return depth.respond(new Response(null, { status: 303, headers: { location: `${depth.ownerLink}/workflows` } }));
  }
  return workflowsReRender(c, depth, form, result.message);
}

/** POST /{owner}/-/projects/{id}/workflows/{wid} (UpdateWorkflow): the same
 *  ladder; the quick enable/disable toggle POSTs only `enabled` and keeps
 *  the stored rules (the replace-vs-toggle contract). */
async function ownerProjectWorkflowUpdateSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const depth = await resolveOwnerProjectDepth(c);
  if (!depth.ok) return depth.response;
  const manageGate = await ownerProjectManageGate(c, depth);
  if (manageGate !== null) return manageGate;
  const workflowId = depth.route.family === "owner-project-workflows" ? depth.route.workflowId : undefined;
  if (workflowId === undefined) return depth.respond(await c.notFound());
  const workflow = await findWorkflowByIdAndProject(c.env.DB, workflowId, depth.project.id);
  if (workflow === null) return depth.respond(c.html(renderNotFound(depth.ctx), 404));
  const form = parseWorkflowForm(await readUrlEncodedForm(c.req.raw));
  const result = await updateWorkflowFromForm(c.env.DB, depth.owner, depth.project, workflow, form, new Date());
  if (result.outcome === "updated") {
    return depth.respond(new Response(null, { status: 303, headers: { location: `${depth.ownerLink}/workflows` } }));
  }
  return workflowsReRender(c, depth, form, result.message);
}

/** POST /{owner}/-/projects/{id}/workflows/{wid}/delete (DeleteWorkflow):
 *  the same ladder, then the 303 onto the workflows page. */
async function ownerProjectWorkflowDeleteSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const depth = await resolveOwnerProjectDepth(c);
  if (!depth.ok) return depth.response;
  const manageGate = await ownerProjectManageGate(c, depth);
  if (manageGate !== null) return manageGate;
  const workflowId = depth.route.family === "owner-project-workflow-delete" ? depth.route.workflowId : undefined;
  if (workflowId === undefined) return depth.respond(await c.notFound());
  const result = await deleteWorkflowFromForm(c.env.DB, depth.project, workflowId);
  if (result.outcome === "missing") return depth.respond(c.html(renderNotFound(depth.ctx), 404));
  return depth.respond(new Response(null, { status: 303, headers: { location: `${depth.ownerLink}/workflows` } }));
}

// ---------------------------------------------------------------------------
// The wave-24 collaboration settings family (pages/settings-collaboration.tsx
// — upstream's /settings/collaboration group, web.go:1194-1204): the panel
// GET plus the five POST writes, every one behind the shared settingsGate
// and the §2.8 sameOriginGuard.
// ---------------------------------------------------------------------------

/** The collaboration re-render's shared tail: the fresh read, the failure
 *  message and the kept `collaborator` submission (the hooks-settings
 *  convention — validation failures re-render at 200). */
async function collaborationReRender(
  c: Context<{ Bindings: Env }>,
  resolved: Extract<ResolvedUiRequest, { ok: true }>,
  options: { error: string | null; collaborator: string },
): Promise<Response> {
  const { ctx, viewer, respond, repo } = resolved;
  const data = await loadCollaborationData(c.env, c.env.DB, repo, viewer);
  return respond(c.html(renderCollaborationPage(ctx, data, options), 200));
}

/** GET /{owner}/{repo}/settings/collaboration (the panel). */
async function collaborationPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const gate = await settingsGate(c, resolved);
  if (gate !== null) return gate;
  return collaborationReRender(c, resolved, { error: null, collaborator: "" });
}

/**
 * POST /{owner}/{repo}/settings/collaboration — the add-collaborator write
 * (upstream CollaborationPost): success and the silent arms 303 back onto
 * the panel, the refused arms re-render with upstream's exact flash text
 * and the kept submission.
 */
async function collaborationAddSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const gate = await settingsGate(c, resolved);
  if (gate !== null) return gate;
  const { respond, repo } = resolved;
  const name = (await readUrlEncodedForm(c.req.raw)).get("collaborator") ?? "";
  const result = await addCollaboratorFromForm(c.env.DB, repo, name, new Date());
  if (result.outcome !== "refused") {
    return respond(new Response(null, { status: 303, headers: { location: `${repoLinkOf(repo)}/settings/collaboration` } }));
  }
  return collaborationReRender(c, resolved, { error: result.message, collaborator: name });
}

/** POST /{owner}/{repo}/settings/collaboration/access_mode — the access-mode
 *  write (upstream ChangeCollaborationAccessMode). */
async function collaborationAccessModeSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const gate = await settingsGate(c, resolved);
  if (gate !== null) return gate;
  const { respond, repo } = resolved;
  const form = await readUrlEncodedForm(c.req.raw);
  const result = await changeAccessModeFromForm(c.env.DB, repo, form, new Date());
  if (result.outcome !== "refused") {
    return respond(new Response(null, { status: 303, headers: { location: `${repoLinkOf(repo)}/settings/collaboration` } }));
  }
  return collaborationReRender(c, resolved, { error: result.message, collaborator: "" });
}

/** POST /{owner}/{repo}/settings/collaboration/delete — the remove write
 *  (upstream DeleteCollaboration). */
async function collaborationDeleteSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const gate = await settingsGate(c, resolved);
  if (gate !== null) return gate;
  const { respond, repo } = resolved;
  const form = await readUrlEncodedForm(c.req.raw);
  const result = await removeCollaboratorFromForm(c.env.DB, repo, form);
  if (result.outcome !== "refused") {
    return respond(new Response(null, { status: 303, headers: { location: `${repoLinkOf(repo)}/settings/collaboration` } }));
  }
  return collaborationReRender(c, resolved, { error: result.message, collaborator: "" });
}

/** POST /{owner}/{repo}/settings/collaboration/team — the add-team write
 *  (upstream AddTeamPost, behind CanDoerManageOrgRepoCollaboratorTeam). */
async function collaborationTeamAddSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const gate = await settingsGate(c, resolved);
  if (gate !== null) return gate;
  const { ctx, viewer, respond, repo } = resolved;
  if (!(await canChangeRepoTeamAccess(c.env, c.env.DB, repo, viewer))) {
    return respond(c.html(renderNotFound(ctx), 404));
  }
  const form = await readUrlEncodedForm(c.req.raw);
  const result = await addTeamFromForm(c.env.DB, repo, form);
  if (result.outcome !== "refused") {
    return respond(new Response(null, { status: 303, headers: { location: `${repoLinkOf(repo)}/settings/collaboration` } }));
  }
  return collaborationReRender(c, resolved, { error: result.message, collaborator: "" });
}

/** POST /{owner}/{repo}/settings/collaboration/team/delete — the remove-team
 *  write (upstream DeleteTeam, the same team gate). */
async function collaborationTeamDeleteSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const gate = await settingsGate(c, resolved);
  if (gate !== null) return gate;
  const { ctx, viewer, respond, repo } = resolved;
  if (!(await canChangeRepoTeamAccess(c.env, c.env.DB, repo, viewer))) {
    return respond(c.html(renderNotFound(ctx), 404));
  }
  const form = await readUrlEncodedForm(c.req.raw);
  const result = await removeTeamFromForm(c.env.DB, repo, form);
  if (result.outcome !== "refused") {
    return respond(new Response(null, { status: 303, headers: { location: `${repoLinkOf(repo)}/settings/collaboration` } }));
  }
  return collaborationReRender(c, resolved, { error: result.message, collaborator: "" });
}

// ---------------------------------------------------------------------------
// The wave-25 repo labels writes (pages/repo-labels.tsx — upstream's
// /labels group, web.go:1417-1422, over the landed repo-label family). The
// shared gate is the module header's port of reqRepoIssuesOrPullsWriter:
// anonymous → the login 303 (reqSignIn), an archived repo or a signed-in
// non-writer → the 404 shell (RepoMustNotBeArchived + the writer arm —
// `canWriteRepo`, the same predicate the page's render gate evaluates).
// ---------------------------------------------------------------------------

/** The labels write gate (the order above; `null` = proceed). */
async function repoLabelsWriteGate(
  c: Context<{ Bindings: Env }>,
  resolved: Extract<ResolvedUiRequest, { ok: true }>,
): Promise<Response | null> {
  const { url, ctx, viewer, repo, respond } = resolved;
  if (viewer.kind === "anonymous") return respond(loginRedirect(url.pathname + url.search));
  if (repo.isArchived || !(await canWriteRepo(c.env, repo, viewer))) {
    return respond(c.html(renderNotFound(ctx), 404));
  }
  return null;
}

/** The create/edit failure re-render's shared tail: the fresh read, the
 *  failure message and the kept create-form submission (the org-labels
 *  handlers' convention — validation failures re-render at 200). */
async function repoLabelsReRender(
  c: Context<{ Bindings: Env }>,
  resolved: Extract<ResolvedUiRequest, { ok: true }>,
  options: { error: string | null; form: { title: string; color: string } },
): Promise<Response> {
  const { ctx, viewer, respond, repo } = resolved;
  const data = await loadRepoLabelsData(c.env, c.env.DB, repo, viewer, new URLSearchParams());
  return respond(c.html(renderRepoLabelsPage({ ctx, data, form: options.form, error: options.error }), 200));
}

/** GET /{owner}/{repo}/labels (pages/repo-labels.tsx — the management list;
 *  anonymous-capable, upstream's optSignIn + reqRepoIssuesOrPullsReader
 *  group). */
async function repoLabelsPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const { url, ctx, viewer, repo, respond } = resolved;
  if (resolved.route.family !== "repo-labels") return respond(await c.notFound()); // drift guard
  const data = await loadRepoLabelsData(c.env, c.env.DB, repo, viewer, url.searchParams);
  return respond(
    c.html(renderRepoLabelsPage({ ctx, data, form: { title: "", color: NEW_LABEL_DEFAULT_COLOR }, error: null }), 200),
  );
}

/**
 * POST /{owner}/{repo}/labels/new (upstream repo.NewLabel over the landed
 * create arm): the §2.8 Origin guard, the write gate, then the
 * empty-title guard + `normalizeLabelColor` + `createRepoLabel` — success
 * 303s back onto the list (upstream JSONRedirect's target), the failures
 * re-render at 200 with the message and the kept submission (the org-labels
 * convention).
 */
async function repoLabelNewSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const gate = await repoLabelsWriteGate(c, resolved);
  if (gate !== null) return gate;
  const { respond, repo } = resolved;
  if (resolved.route.family !== "repo-label-new") return respond(await c.notFound()); // drift guard
  const form = parseRepoLabelForm(await readUrlEncodedForm(c.req.raw));
  const result = await createRepoLabelFromForm(c.env.DB, repo.id, form);
  if (result.outcome === "applied") {
    return respond(new Response(null, { status: 303, headers: { location: `${repoLinkOf(repo)}/labels` } }));
  }
  return repoLabelsReRender(c, resolved, { error: result.message, form });
}

/**
 * POST /{owner}/{repo}/labels/edit (upstream repo.UpdateLabel over the
 * landed edit arm's order — the repo-scoped lookup before any color 422):
 * success 303s back onto the list; a missing/foreign id 404-shells (the
 * landed PATCH arm's plain "not found" — upstream's JSONErrorNotFound);
 * the failures re-render with the error banner and the STORED row values
 * (pages/repo-labels.tsx's re-render note).
 */
async function repoLabelEditSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const gate = await repoLabelsWriteGate(c, resolved);
  if (gate !== null) return gate;
  const { respond, repo } = resolved;
  if (resolved.route.family !== "repo-label-edit") return respond(await c.notFound()); // drift guard
  const params = await readUrlEncodedForm(c.req.raw);
  const form = parseRepoLabelForm(params);
  const result = await editRepoLabelFromForm(c.env.DB, repo.id, formLabelId(params.get("id")), form);
  if (result.outcome === "applied") {
    return respond(new Response(null, { status: 303, headers: { location: `${repoLinkOf(repo)}/labels` } }));
  }
  if (result.outcome === "missing") return respond(c.html(renderNotFound(resolved.ctx), 404));
  return repoLabelsReRender(c, resolved, { error: result.message, form: { title: "", color: NEW_LABEL_DEFAULT_COLOR } });
}

/**
 * POST /{owner}/{repo}/labels/delete (upstream repo.DeleteLabel over the
 * landed cascade arm): the repo-scoped lookup, the delete when the row
 * exists, SUCCESS either way (the arm's zero-row 204 and upstream's
 * unconditional JSONRedirect) — both arms 303 back onto the list.
 */
async function repoLabelDeleteSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const gate = await repoLabelsWriteGate(c, resolved);
  if (gate !== null) return gate;
  const { respond, repo } = resolved;
  if (resolved.route.family !== "repo-label-delete") return respond(await c.notFound()); // drift guard
  const params = await readUrlEncodedForm(c.req.raw);
  await deleteRepoLabelFromForm(c.env.DB, repo.id, formLabelId(params.get("id")));
  return respond(new Response(null, { status: 303, headers: { location: `${repoLinkOf(repo)}/labels` } }));
}

// ---------------------------------------------------------------------------
// The wave-45 repo projects surface (pages/repo-projects.tsx — upstream's
// /{username}/{reponame}/projects group, web.go:1544-1563, the survey's
// re-ranked #1): the list + board + write group + workflow tails over the
// landed repo-scope service arms. Every family rides resolveUiRequest (the
// §2.5 repo read — the requireVisibleRepo family; the wave-24 collaboration
// handlers' composition), then the unit toggle, then — writes only — the
// shared repo write ladder.
// ---------------------------------------------------------------------------

/** The wave-45 families' guard — the prologue accepts exactly these. */
function isRepoProjectsRoute(route: ParsedUiRoute): route is RepoProjectsRoute {
  return (
    route.family === "repo-projects" ||
    route.family === "repo-project-new" ||
    route.family === "repo-project-board" ||
    route.family === "repo-project-edit" ||
    route.family === "repo-project-delete" ||
    route.family === "repo-project-status" ||
    route.family === "repo-project-column-new" ||
    route.family === "repo-project-column-default" ||
    route.family === "repo-project-workflows" ||
    route.family === "repo-project-workflow-delete"
  );
}

type ResolvedRepoProjects = Extract<ResolvedUiRequest, { ok: true }> & { route: RepoProjectsRoute };

/**
 * The group's shared prologue: the repo resolution (invisible repo → the
 * 404 shell), then `repo.MustEnableRepoProjects` (repo/projects.go:43-58)
 * reduced to the loaded `repoHasProjects` toggle (the read group's last
 * arm; a disabled unit is the NotFound shell — the tab rides the same flag).
 */
async function resolveRepoProjectsRequest(
  c: Context<{ Bindings: Env }>,
): Promise<ResolvedRepoProjects | { ok: false; response: Response }> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved;
  if (!isRepoProjectsRoute(resolved.route)) return { ok: false, response: await c.notFound() }; // drift guard
  if (resolved.ctx.repoHasProjects !== true) {
    return { ok: false, response: resolved.respond(c.html(renderNotFound(resolved.ctx), 404)) };
  }
  return { ...resolved, route: resolved.route };
}

/**
 * The write group's gate (web.go:1562's reqRepoProjectsWriter +
 * RepoMustNotBeArchived): the same ladder the wave-25 labels writes run —
 * anonymous → the login 303, an archived repo or a signed-in non-writer →
 * the 404 shell — reused verbatim. CanManageWorkflows' repo arm (the
 * workflows' second layer, workflow.go:24-31) collapses into the same
 * repo-wide writer (routes/projects-repo.ts's requireWorkflowManager
 * reduction), so this one gate covers the workflow writes too.
 */
const repoProjectsWriteGate = repoLabelsWriteGate;

/**
 * The {id} families' shared depth: the group prologue, then the repo-scoped
 * project read (GetProjectByID over `repoProjectScope(repo.id)` — another
 * repo's id reads as not found, the upstream handlers' RepoID-mismatch arm
 * folded into the scope condition). `route.id ?? 0` — the list/new families
 * never reach here, and id 0 matches no row.
 */
async function resolveRepoProjectDepth(
  c: Context<{ Bindings: Env }>,
): Promise<Extract<ResolvedRepoProjects, { ok: true }> & { project: ProjectRow } | { ok: false; response: Response }> {
  const resolved = await resolveRepoProjectsRequest(c);
  if (!resolved.ok) return resolved;
  const project = await findProjectById(c.env.DB, repoProjectScope(resolved.repo.id), resolved.route.id ?? 0);
  if (project === null) return { ok: false, response: resolved.respond(c.html(renderNotFound(resolved.ctx), 404)) };
  return { ...resolved, project };
}

/** GET /{owner}/{repo}/projects (repo.Projects — the list; every viewer who
 *  can see the repo with the unit enabled). */
async function repoProjectsPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveRepoProjectsRequest(c);
  if (!resolved.ok) return resolved.response;
  const { url, ctx, viewer, repo, respond, route } = resolved;
  if (route.family !== "repo-projects") return respond(await c.notFound()); // drift guard
  const data = await loadRepoProjectsData(c.env, c.env.DB, repo, viewer, url.searchParams);
  return respond(c.html(renderRepoProjectsPage(ctx, data), 200));
}

/** GET /{owner}/{repo}/projects/new (repo.RenderNewProject — the write
 *  group's form; the gate is the route group's, run before any render). */
async function repoProjectNewPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveRepoProjectsRequest(c);
  if (!resolved.ok) return resolved.response;
  const { ctx, repo, respond, route } = resolved;
  if (route.family !== "repo-project-new") return respond(await c.notFound()); // drift guard
  const gate = await repoProjectsWriteGate(c, resolved);
  if (gate !== null) return gate;
  return respond(
    c.html(
      renderRepoProjectNewPage({ ctx, repo, form: { title: "", content: "", templateType: "", cardType: "" }, error: null }),
      200,
    ),
  );
}

/** POST /{owner}/{repo}/projects/new (repo.NewProjectPost): success 303s
 *  onto the LIST (upstream's RepoLink+/projects Redirect), the binding
 *  failures re-render at 200 with the message and the kept submission. */
async function repoProjectNewSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveRepoProjectsRequest(c);
  if (!resolved.ok) return resolved.response;
  const { ctx, viewer, repo, respond, route } = resolved;
  if (route.family !== "repo-project-new") return respond(await c.notFound()); // drift guard
  const gate = await repoProjectsWriteGate(c, resolved);
  if (gate !== null) return gate;
  if (viewer.kind !== "user") return respond(c.html(renderNotFound(ctx), 404));
  const form = parseProjectForm(await readUrlEncodedForm(c.req.raw));
  const result = await createRepoProjectFromForm(c.env.DB, repo, viewer.id, form, new Date());
  if (result.outcome === "created") {
    return respond(new Response(null, { status: 303, headers: { location: `${repoLinkOf(repo)}/projects` } }));
  }
  return respond(c.html(renderRepoProjectNewPage({ ctx, repo, form, error: result.message }), 200));
}

/** GET /{owner}/{repo}/projects/{id} (repo.ViewProject — the board). */
async function repoProjectBoardPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const depth = await resolveRepoProjectDepth(c);
  if (!depth.ok) return depth.response;
  const { url, ctx, viewer, repo, respond, route, project } = depth;
  if (route.family !== "repo-project-board") return respond(await c.notFound()); // drift guard
  const data = await loadRepoProjectBoardData(c.env, c.env.DB, repo, project, viewer, url.searchParams);
  return respond(
    c.html(renderRepoProjectBoardPage({ ctx, data, columnForm: { title: "", color: "" }, columnError: null }), 200),
  );
}

/** GET /{owner}/{repo}/projects/{id}/edit (repo.RenderEditProject — the
 *  pre-filled shared form; `?redirect=project` rides the hidden field). */
async function repoProjectEditPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const depth = await resolveRepoProjectDepth(c);
  if (!depth.ok) return depth.response;
  const { url, ctx, repo, respond, route, project } = depth;
  if (route.family !== "repo-project-edit") return respond(await c.notFound()); // drift guard
  const gate = await repoProjectsWriteGate(c, depth);
  if (gate !== null) return gate;
  const data = await loadRepoProjectBoardData(c.env, c.env.DB, repo, project, depth.viewer, new URLSearchParams());
  return respond(
    c.html(
      renderRepoProjectEditPage({
        ctx,
        data,
        form: {
          title: project.title,
          content: project.description,
          templateType: "",
          cardType: cardTypeToString(project.cardType),
        },
        error: null,
        redirect: url.searchParams.get("redirect") ?? "",
      }),
      200,
    ),
  );
}

/** POST /{owner}/{repo}/projects/{id}/edit (repo.EditProjectPost): success
 *  303s onto the board when the hidden `redirect=project` rode (upstream's
 *  p.Link() Redirect), else onto the LIST; failures re-render at 200. */
async function repoProjectEditSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const depth = await resolveRepoProjectDepth(c);
  if (!depth.ok) return depth.response;
  const { ctx, viewer, repo, respond, route, project } = depth;
  if (route.family !== "repo-project-edit") return respond(await c.notFound()); // drift guard
  const gate = await repoProjectsWriteGate(c, depth);
  if (gate !== null) return gate;
  const formParams = await readUrlEncodedForm(c.req.raw);
  const form = parseProjectForm(formParams);
  const result = await updateProjectFromForm(c.env.DB, project, form, new Date());
  if (result.outcome === "updated") {
    const target =
      formParams.get("redirect") === "project" ? repoProjectLink(repo, project) : `${repoLinkOf(repo)}/projects`;
    return respond(new Response(null, { status: 303, headers: { location: target } }));
  }
  const data = await loadRepoProjectBoardData(c.env, c.env.DB, repo, project, viewer, new URLSearchParams());
  return respond(
    c.html(
      renderRepoProjectEditPage({
        ctx,
        data,
        form,
        error: result.message,
        redirect: formParams.get("redirect") ?? "",
      }),
      200,
    ),
  );
}

/** POST /{owner}/{repo}/projects/{id}/delete (repo.DeleteProject): the
 *  cascade delete then the 303 onto the LIST (upstream's JSONRedirect
 *  target). */
async function repoProjectDeleteSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const depth = await resolveRepoProjectDepth(c);
  if (!depth.ok) return depth.response;
  const { respond, route, project } = depth;
  if (route.family !== "repo-project-delete") return respond(await c.notFound()); // drift guard
  const gate = await repoProjectsWriteGate(c, depth);
  if (gate !== null) return gate;
  await deleteProjectById(c.env.DB, project.id);
  return depth.respond(new Response(null, { status: 303, headers: { location: `${repoLinkOf(depth.repo)}/projects` } }));
}

/** POST /{owner}/{repo}/projects/{id}/open|close
 *  (repo.ChangeProjectStatus): the guarded flip then the 303 onto the board
 *  (upstream's JSONRedirect → ProjectLinkForRepo). */
async function repoProjectStatusSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const depth = await resolveRepoProjectDepth(c);
  if (!depth.ok) return depth.response;
  const { respond, route, project } = depth;
  if (route.family !== "repo-project-status") return respond(await c.notFound()); // drift guard
  const gate = await repoProjectsWriteGate(c, depth);
  if (gate !== null) return gate;
  const action = route.action;
  if (action !== "open" && action !== "close") return depth.respond(await c.notFound());
  await changeProjectStatus(c.env.DB, project, action === "close", new Date());
  return depth.respond(new Response(null, { status: 303, headers: { location: repoProjectLink(depth.repo, project) } }));
}

/** POST /{owner}/{repo}/projects/{id}/columns/new
 *  (repo.AddColumnToProjectPost via addProjectBoardRoutes): the board
 *  re-renders at 200 with the message + kept values on the failure arms,
 *  303s onto the board on success. */
async function repoProjectColumnNewSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const depth = await resolveRepoProjectDepth(c);
  if (!depth.ok) return depth.response;
  const { url, ctx, viewer, repo, respond, route, project } = depth;
  if (route.family !== "repo-project-column-new") return respond(await c.notFound()); // drift guard
  const gate = await repoProjectsWriteGate(c, depth);
  if (gate !== null) return gate;
  if (viewer.kind !== "user") return respond(c.html(renderNotFound(ctx), 404));
  const form = parseColumnForm(await readUrlEncodedForm(c.req.raw));
  const result = await createColumnFromForm(c.env.DB, project, viewer.id, form, new Date());
  if (result.outcome === "created") {
    return respond(new Response(null, { status: 303, headers: { location: repoProjectLink(repo, project) } }));
  }
  const data = await loadRepoProjectBoardData(c.env, c.env.DB, repo, project, viewer, url.searchParams);
  return respond(c.html(renderRepoProjectBoardPage({ ctx, data, columnForm: form, columnError: result.message }), 200));
}

/** POST /{owner}/{repo}/projects/{id}/{columnID}/default
 *  (repo.SetDefaultProjectColumn): a foreign column id 404-shells, success
 *  303s onto the board. */
async function repoProjectColumnDefaultSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const depth = await resolveRepoProjectDepth(c);
  if (!depth.ok) return depth.response;
  const { ctx, respond, route, project } = depth;
  if (route.family !== "repo-project-column-default") return respond(await c.notFound()); // drift guard
  const gate = await repoProjectsWriteGate(c, depth);
  if (gate !== null) return gate;
  const columnId = route.columnId;
  if (columnId === undefined) return respond(await c.notFound());
  const result = await setProjectDefaultColumnFromForm(c.env.DB, project, columnId, new Date());
  if (result.outcome === "missing") return respond(c.html(renderNotFound(ctx), 404));
  return depth.respond(new Response(null, { status: 303, headers: { location: repoProjectLink(depth.repo, project) } }));
}

/** The workflows re-render's shared tail (the ?workflow_id focus — an
 *  unknown id 404-shells, RenderWorkflows' slices.ContainsFunc arm — then
 *  the page). The ?event validation is the GET handler's arm (the POST
 *  re-render must reach the page with the service's 422 message). */
async function repoProjectWorkflowsReRender(
  c: Context<{ Bindings: Env }>,
  depth: Extract<ResolvedRepoProjects, { ok: true }> & { project: ProjectRow },
  form: WorkflowForm,
  error: string | null,
): Promise<Response> {
  const { url, ctx, viewer, repo, respond } = depth;
  const data = await loadRepoProjectWorkflowsData(c.env, c.env.DB, repo, depth.project, viewer, url.searchParams);
  if (depth.route.workflowId !== undefined) {
    const focused = await findWorkflowByIdAndProject(c.env.DB, depth.route.workflowId, depth.project.id);
    if (focused === null) return respond(c.html(renderNotFound(ctx), 404));
    data.workflowId = depth.route.workflowId;
  }
  return respond(c.html(renderRepoProjectWorkflowsPage({ ctx, data, form, error }), 200));
}

/** GET /{owner}/{repo}/projects/{id}/workflows[/{wid}]
 *  (repo.ProjectWorkflows → RenderWorkflows) — the read group gates it; the
 *  edit arms ride canManage inside the render (the repo arm's collapse into
 *  the writer grant — the page module's gate note). An unknown `?event=`
 *  preselect 404-shells. */
async function repoProjectWorkflowsPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const depth = await resolveRepoProjectDepth(c);
  if (!depth.ok) return depth.response;
  const { respond, route } = depth;
  if (route.family !== "repo-project-workflows") return respond(await c.notFound()); // drift guard
  const event = depth.url.searchParams.get("event");
  if (event !== null && event !== "" && !WORKFLOW_EVENTS.some((entry) => entry.event === event)) {
    return depth.respond(c.html(renderNotFound(depth.ctx), 404));
  }
  return repoProjectWorkflowsReRender(c, depth, emptyWorkflowForm(event ?? ""), null);
}

/** POST /{owner}/{repo}/projects/{id}/workflows (CreateWorkflow): the
 *  service 422s re-render at 200, success 303s onto the workflows page. */
async function repoProjectWorkflowCreateSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const depth = await resolveRepoProjectDepth(c);
  if (!depth.ok) return depth.response;
  const { respond, route } = depth;
  if (route.family !== "repo-project-workflows") return respond(await c.notFound()); // drift guard
  const gate = await repoProjectsWriteGate(c, depth);
  if (gate !== null) return gate;
  const form = parseWorkflowForm(await readUrlEncodedForm(c.req.raw));
  const result = await createRepoWorkflowFromForm(c.env.DB, depth.repo, depth.project, form, new Date());
  if (result.outcome === "created") {
    return depth.respond(
      new Response(null, { status: 303, headers: { location: `${repoProjectLink(depth.repo, depth.project)}/workflows` } }),
    );
  }
  return repoProjectWorkflowsReRender(c, depth, form, result.message);
}

/** POST /{owner}/{repo}/projects/{id}/workflows/{wid} (UpdateWorkflow): the
 *  same ladder; the quick enable/disable toggle POSTs only `enabled` and
 *  keeps the stored rules (the replace-vs-toggle contract). */
async function repoProjectWorkflowUpdateSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const depth = await resolveRepoProjectDepth(c);
  if (!depth.ok) return depth.response;
  const { respond, route } = depth;
  if (route.family !== "repo-project-workflows" || route.workflowId === undefined) {
    return respond(await c.notFound()); // drift guard
  }
  const gate = await repoProjectsWriteGate(c, depth);
  if (gate !== null) return gate;
  const workflow = await findWorkflowByIdAndProject(c.env.DB, route.workflowId, depth.project.id);
  if (workflow === null) return depth.respond(c.html(renderNotFound(depth.ctx), 404));
  const form = parseWorkflowForm(await readUrlEncodedForm(c.req.raw));
  const result = await updateRepoWorkflowFromForm(c.env.DB, depth.repo, depth.project, workflow, form, new Date());
  if (result.outcome === "updated") {
    return depth.respond(
      new Response(null, { status: 303, headers: { location: `${repoProjectLink(depth.repo, depth.project)}/workflows` } }),
    );
  }
  return repoProjectWorkflowsReRender(c, depth, form, result.message);
}

/** POST /{owner}/{repo}/projects/{id}/workflows/{wid}/delete
 *  (DeleteWorkflow): the same ladder, then the 303 onto the workflows page;
 *  a foreign/unknown id 404-shells. */
async function repoProjectWorkflowDeleteSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const depth = await resolveRepoProjectDepth(c);
  if (!depth.ok) return depth.response;
  const { respond, route } = depth;
  if (route.family !== "repo-project-workflow-delete" || route.workflowId === undefined) {
    return respond(await c.notFound()); // drift guard
  }
  const gate = await repoProjectsWriteGate(c, depth);
  if (gate !== null) return gate;
  const result = await deleteWorkflowFromForm(c.env.DB, depth.project, route.workflowId);
  if (result.outcome === "missing") return depth.respond(c.html(renderNotFound(depth.ctx), 404));
  return depth.respond(
    new Response(null, { status: 303, headers: { location: `${repoProjectLink(depth.repo, depth.project)}/workflows` } }),
  );
}

// ---------------------------------------------------------------------------
// The wave-26 milestone detail + edit (pages/milestone-detail.tsx —
// upstream web.go:1340's reader route and web.go:1427-1428's writer combo)
// and the fork form (pages/repo-fork.tsx — web.go:1490's combo over the
// landed createFork machinery)
// ---------------------------------------------------------------------------

/** GET /{owner}/{repo}/milestone/{id} (pages/milestone-detail.tsx — the
 *  milestone's issues-and-pulls list; every viewer who can see the repo; the
 *  write predicate rides along for the Edit button). */
async function milestoneDetailPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const { url, ctx, viewer, respond, repo } = resolved;
  if (resolved.route.family !== "milestone-detail") return respond(await c.notFound()); // drift guard
  const data = await loadMilestoneDetailData(c.env.DB, repo, resolved.route.id, url.searchParams, ctx.origin);
  if (data === null) return respond(c.html(renderNotFound(ctx), 404));
  // reqRepoIssuesOrPullsWriter's landed port (the wave-25 labels page's
  // predicate — NOT the milestone-new module's older admin reduction); the
  // page hides every control on archived repos itself (upstream's
  // `if not .Repository.IsArchived` wrapper).
  data.canWrite = await canWriteRepo(c.env, repo, viewer);
  return respond(c.html(renderMilestoneDetailPage(ctx, data), 200));
}

/** The milestone edit gate — upstream's write group (reqSignIn +
 *  RepoMustNotBeArchived + reqRepoIssuesOrPullsWriter) is EXACTLY the
 *  labels-write gate's order, so the landed `repoLabelsWriteGate` runs
 *  verbatim: anonymous → the login 303 (repo resolution FIRST), an archived
 *  repo or a signed-in non-writer → the 404 shell. */

/** GET /{owner}/{repo}/milestones/{id}/edit (pages/milestone-detail.tsx —
 *  the form, the stored values prefilled). */
async function milestoneEditPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const gate = await repoLabelsWriteGate(c, resolved);
  if (gate !== null) return gate;
  const { ctx, respond, repo } = resolved;
  if (resolved.route.family !== "milestone-edit") return respond(await c.notFound()); // drift guard
  const data = await loadMilestoneEditData(c.env.DB, repo.id, resolved.route.id);
  if (data === null) return respond(c.html(renderNotFound(ctx), 404));
  return respond(
    c.html(
      renderMilestoneEditPage({ ctx, milestone: data.milestone, form: milestoneEditFormOf(data.milestone), error: null }),
      200,
    ),
  );
}

/**
 * POST /{owner}/{repo}/milestones/{id}/edit (upstream EditMilestonePost):
 * the §2.8 Origin guard, the write gate, the repo-scoped milestone lookup
 * (missing/foreign id 404-shells — the handler's own GetMilestoneByRepoID
 * order), then the landed `editRepoMilestone` — success 303s back onto the
 * list (upstream's redirect), validation failures re-render at 200 with the
 * message and the kept values (the login failure convention).
 */
async function milestoneEditSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const gate = await repoLabelsWriteGate(c, resolved);
  if (gate !== null) return gate;
  const { ctx, respond, repo } = resolved;
  if (resolved.route.family !== "milestone-edit") return respond(await c.notFound()); // drift guard
  const data = await loadMilestoneEditData(c.env.DB, repo.id, resolved.route.id);
  if (data === null) return respond(c.html(renderNotFound(ctx), 404));
  const form = parseMilestoneForm(await readUrlEncodedForm(c.req.raw));
  const result = await editMilestoneFromForm(c.env.DB, data.milestone.id, form);
  if (result.outcome === "applied") {
    return respond(new Response(null, { status: 303, headers: { location: `/${repo.ownerNamespace}/${repo.slug}/milestones` } }));
  }
  return respond(c.html(renderMilestoneEditPage({ ctx, milestone: data.milestone, form, error: result.message }), 200));
}

/** GET /{owner}/{repo}/fork (pages/repo-fork.tsx — the form). The combo's
 *  gate order: repo resolution FIRST (invisible repos 404 before the
 *  redirect could leak), then reqSignIn's login 303, then
 *  getForkRepository's IsEmpty arm (an empty source has nothing to fork). */
async function repoForkPage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const { url, ctx, viewer, respond, repo } = resolved;
  if (resolved.route.family !== "repo-fork") return respond(await c.notFound()); // drift guard
  if (viewer.kind === "anonymous") return respond(loginRedirect(url.pathname + url.search));
  if (repo.isEmpty) return respond(c.html(renderNotFound(ctx), 404));
  const data = await loadRepoForkData(c.env, c.env.DB, repo, viewer);
  if (data === null) return respond(c.html(renderNotFound(ctx), 404));
  return respond(
    c.html(renderRepoForkPage({ ctx, data, form: { uid: data.selectedId, name: data.source.repo.slug }, error: null }), 200),
  );
}

/**
 * POST /{owner}/{repo}/fork (upstream ForkPost): the §2.8 Origin guard, the
 * GET's gate order, then the landed POST /repos/{owner}/{repo}/forks
 * route's exact service sequence through createForkFromForm — success 303s
 * onto the fork's home (upstream's JSONRedirect target), an EXISTING fork
 * 303s onto its home (the GetUserFork arm), validation failures re-render
 * at 200 with the message and the kept values.
 */
async function repoForkSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const { url, ctx, viewer, respond, repo } = resolved;
  if (resolved.route.family !== "repo-fork") return respond(await c.notFound()); // drift guard
  if (viewer.kind === "anonymous") return respond(loginRedirect(url.pathname + url.search));
  if (repo.isEmpty) return respond(c.html(renderNotFound(ctx), 404));
  const data = await loadRepoForkData(c.env, c.env.DB, repo, viewer);
  if (data === null) return respond(c.html(renderNotFound(ctx), 404));
  const form = parseRepoForkForm(await readUrlEncodedForm(c.req.raw));
  const result = await createForkFromForm(c.env, c.env.DB, viewer, data, form);
  if (result.outcome === "existing") {
    return respond(new Response(null, { status: 303, headers: { location: result.location } }));
  }
  if (result.outcome === "created") {
    return respond(
      new Response(null, { status: 303, headers: { location: `/${result.ownerNamespace}/${result.slug}` } }),
    );
  }
  return respond(c.html(renderRepoForkPage({ ctx, data, form, error: result.message }), 200));
}

export const uiRouter = new Hono<{ Bindings: Env }>();

// §4.13: trailing-slash URLs redirect to the canonical form (we never emit
// them). Default mode rewrites only when the trimmed path matched a claimed
// route (the response was a 404), so it cannot launder unclaimed paths.
uiRouter.use(trimTrailingSlash());

// The UI's HTML is PER-VIEWER state (settings tabs render the doer's own
// rows). Upstream sets this globally via middleware (the web context's
// zero-option prod form — httpcache.go); without it an intermediary
// heuristically cached per-user pages and a create→reload rendered the row
// MISSING (RD20's live probe: visible with a no-cache request header,
// invisible for minutes without — real bug #19, caught only in production).
uiRouter.use(async (c, next) => {
  await next();
  const res = c.res;
  if (res !== undefined && (res.headers.get("cache-control") === null || res.headers.get("cache-control") === "")) {
    const headers = new Headers(res.headers);
    headers.set("cache-control", "max-age=0, private, must-revalidate");
    c.res = new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  }
});

// The claimed families (§2.1), registered exactly as parseUiRoute classifies
// them so the sub-app's reach equals handlesUiRoute's. HEAD is intentionally
// unregistered (GET-only surface, §2.1): a HEAD request misses into the
// parent app's plain 404 — identical to today's engine answer for these
// paths.
//
// Wave-9 site families register FIRST, physically before every dynamic
// family: the explore literals (/explore, /explore/repos, /explore/users)
// and the site root must win against /:owner/:repo and the owner regex —
// registration order is what makes the static-before-dynamic precedence
// local and obvious (the same rule the /issues/new literal follows below).
// Verified against this Hono pin's RegExpRouter: a static registered after
// the dynamic pair LOSES to it — /explore/repos would land in uiPage's
// drift guard and 404.
uiRouter.get("/", (c) => siteHomePage(c));
uiRouter.get("/explore", () => exploreRoot());
uiRouter.get("/explore/repos", (c) => exploreReposPage(c));
uiRouter.get("/explore/users", (c) => exploreUsersPage(c));
// The org search page (this wave — upstream web.go:557's literal; parseUiRoute
// claims the exact 3-segment shape).
uiRouter.get("/explore/organizations", (c) => exploreOrganizationsPage(c));
// The SPEC-0019 M2 code search page (upstream web.go:558's literal; the
// exact 3-segment literal beside its siblings — the navbar's fourth tab).
uiRouter.get("/explore/code", (c) => exploreCodePage(c));
// The ORG-scoped inbox families (parseUiRoute claims exactly these 4-/5-
// segment shapes — upstream web.go:986-991's `/org/{org}` group). Registered
// in the STATIC block, physically before the dynamic /:owner/:repo pairs:
// this Hono pin's RegExpRouter lets an earlier dynamic pattern beat a later
// static one (the wave-9 note's verified rule — /org/{org}/issues would
// otherwise land in the repo-issues family's drift guard, the first-match
// class), and the drift guards absorb any future collision loudly.
uiRouter.get("/org/:owner/issues", (c) => orgInboxPage(c));
uiRouter.get("/org/:owner/issues/:team", (c) => orgInboxPage(c));
uiRouter.get("/org/:owner/pulls", (c) => orgInboxPage(c));
uiRouter.get("/org/:owner/pulls/:team", (c) => orgInboxPage(c));
uiRouter.get("/org/:owner/milestones", (c) => orgInboxPage(c));
uiRouter.get("/org/:owner/milestones/:team", (c) => orgInboxPage(c));
// Wave-10 notifications family (parseUiRoute claims exactly these literal
// shapes; registered with the wave-9 statics so the literals beat the
// dynamic owner/repo and owner regexes — the wave-9 RegExpRouter note). The
// POST-only write tails answer GET with chi's 405 (the same convention the
// comment/label write families carry).
uiRouter.get("/notifications", (c) => notificationsPage(c));
uiRouter.get("/notifications/subscriptions", (c) => notificationSubscriptionsPage(c, false));
uiRouter.get("/notifications/watching", (c) => notificationSubscriptionsPage(c, true));
uiRouter.get("/notifications/new", (c) => notificationsNew(c));
uiRouter.post("/notifications/status", (c) => notificationStatusSubmit(c));
uiRouter.post("/notifications/purge", (c) => notificationPurgeSubmit(c));
uiRouter.post("/notifications/purge-page", (c) => notificationPurgePageSubmit(c));
uiRouter.get("/notifications/purge-page", () => methodNotAllowed("POST"));
uiRouter.get("/notifications/status", () => methodNotAllowed("POST"));
uiRouter.get("/notifications/purge", () => methodNotAllowed("POST"));
// Wave-12 families (parseUiRoute claims exactly these shapes; registered
// with the wave-9 statics so the literals beat the dynamic owner/repo and
// owner regexes — the wave-9 RegExpRouter note: a static registered after
// the dynamic pair LOSES to it, and /:owner/teams must beat /:owner/:repo
// the same way). The POST-only tails answer GET with chi's 405 posture is
// not needed here: /user/settings POST carries the literal GET above, and
// the teams POSTs hang off the /new literal's own GET+POST pair.
uiRouter.get("/user/settings", (c) => userSettingsPage(c));
// Window-2a: the tab families (each parse family's method arms — the
// modules' handoff recipes).
uiRouter.get("/user/settings/appearance", (c) => userSettingsAppearancePage(c));
uiRouter.post("/user/settings/appearance/theme", (c) => userSettingsAppearanceSubmit(c, "theme"));
uiRouter.post("/user/settings/appearance/language", (c) => userSettingsAppearanceSubmit(c, "language"));
uiRouter.get("/user/settings/security", (c) => userSettingsSecurityPage(c));
uiRouter.get("/user/settings/actions/secrets", (c) => userSettingsSecretsPage(c));
uiRouter.post("/user/settings/actions/secrets", (c) => userSettingsSecretsSubmit(c));
uiRouter.post("/user/settings/actions/secrets/delete", (c) => userSettingsSecretsDelete(c));
uiRouter.get("/user/settings/actions/variables", (c) => userSettingsVariablesPage(c));
uiRouter.post("/user/settings/actions/variables/new", (c) => userSettingsVariablesNew(c));
uiRouter.post("/user/settings/actions/variables/:id/edit", (c) => userSettingsVariablesEdit(c, Number(c.req.param("id"))));
uiRouter.post("/user/settings/actions/variables/:id/delete", (c) => userSettingsVariablesDelete(c, Number(c.req.param("id"))));
uiRouter.get("/user/settings/hooks", (c) => userSettingsHooksPage(c));
uiRouter.post("/user/settings/hooks", (c) => userSettingsHooksCreate(c));
uiRouter.get("/user/settings/hooks/:id", (c) => userHookDetailPage(c, Number(c.req.param("id"))));
uiRouter.post("/user/settings/hooks/:id", (c) => userHookDetailSubmit(c, Number(c.req.param("id"))));
uiRouter.post("/user/settings/hooks/:id/delete", (c) => userHookDelete(c, Number(c.req.param("id"))));
uiRouter.get("/user/settings/keys", (c) => userSettingsKeysPage(c));
uiRouter.post("/user/settings/keys", (c) => userSettingsKeysSubmit(c));
uiRouter.post("/user/settings/keys/delete", (c) => userSettingsKeysDelete(c));
uiRouter.get("/user/settings/applications", (c) => userSettingsApplicationsPage(c));
uiRouter.post("/user/settings/applications", (c) => userSettingsApplicationsSubmit(c));
uiRouter.post("/user/settings/applications/delete", (c) => userSettingsApplicationsDelete(c));
// The account tab (navbar.tmpl:7-11 — the GET page + the three POST arms).
uiRouter.get("/user/settings/account", (c) => userSettingsAccountPage(c));
uiRouter.post("/user/settings/account/email", (c) => userSettingsAccountEmailSubmit(c));
uiRouter.post("/user/settings/account/email/delete", (c) => userSettingsAccountEmailDelete(c));
uiRouter.post("/user/settings/account/delete", (c) => userSettingsAccountDelete(c));
// The notifications tab (navbar.tmpl:12-16 — the GET page + the two
// preference POSTs).
uiRouter.get("/user/settings/notifications", (c) => userSettingsNotificationsPage(c));
uiRouter.get("/user/settings/repos", (c) => userSettingsReposPage(c));
uiRouter.post("/user/settings/notifications/email", (c) => userSettingsNotificationsSubmit(c, "email"));
uiRouter.post("/user/settings/notifications/actions", (c) => userSettingsNotificationsSubmit(c, "actions"));
uiRouter.get("/user/settings/organization", (c) => userSettingsOrganizationsPage(c));
uiRouter.post("/user/settings/organization/leave", (c) => userSettingsOrganizationsLeave(c));
uiRouter.post("/user/settings", (c) => userSettingsSubmit(c));
// Wave-19 creation pages (parseUiRoute claims exactly these literal shapes —
// upstream's reqSignIn /repo/create + /org/create groups; registered with
// the wave-9/12 statics so the literals beat the dynamic owner/repo pair —
// the wave-9 RegExpRouter note). The POSTs run the §2.8 sameOriginGuard.
uiRouter.get("/repo/create", (c) => repoCreatePage(c));
// Window-2e statics — MUST register ahead of the dynamic /:owner/:repo block
// below (hono's RegExpRouter honors registration order; the late spot left
// these GETs dead in uiPage's drift guard — the migrate-inbox matrix's RED,
// the wiki #11 registration-order lesson repeated).
uiRouter.get("/repo/search", (c) => repoSearchAuxRoute(c));
uiRouter.get("/repo/migrate", (c) => repoMigratePage(c));
uiRouter.post("/repo/create", (c) => repoCreateSubmit(c));
uiRouter.get("/org/create", (c) => orgCreatePage(c));
uiRouter.post("/org/create", (c) => orgCreateSubmit(c));
uiRouter.get("/:owner/teams", (c) => orgTeamsPage(c));
uiRouter.get("/:owner/teams/new", (c) => orgTeamNewPage(c));
uiRouter.post("/:owner/teams/new", (c) => orgTeamNewSubmit(c));
uiRouter.get("/:owner/teams/:id", (c) => orgTeamDetailPage(c));
// Wave-49 team edit + delete (parseUiRoute claims exactly these shapes —
// upstream web.go:1011-1013's edit combo and delete POST; the edit carries
// GET + POST, the delete tail answers GET with chi's 405 — the hook
// test/delete convention; the POSTs run the §2.8 sameOriginGuard first). No
// earlier registration can absorb these: the deeper :id/edit and :id/delete
// tails are 5-segment shapes the wave-12 lines do not carry, and the parser
// claims positive integers only.
uiRouter.get("/:owner/teams/:id/edit", (c) => orgTeamEditPage(c));
uiRouter.post("/:owner/teams/:id/edit", (c) => orgTeamEditSubmit(c));
uiRouter.post("/:owner/teams/:id/delete", (c) => orgTeamDeleteSubmit(c));
uiRouter.get("/:owner/teams/:id/delete", () => methodNotAllowed("POST"));
// Wave-49 org settings family (parseUiRoute claims exactly these shapes —
// upstream web.go:1017-1092's /settings subtree: the options combo (GET +
// POST), the avatar write pair and the danger-zone rename/delete/visibility
// POST segments; the POST-only tails answer GET with chi's 405 — the
// hook-test convention, and the POSTs run the §2.8 sameOriginGuard first).
// The literal `settings` registers with the wave-9/12 statics so it beats
// the dynamic /:owner/:repo pair — upstream's require-owner /{org} group
// registers ahead of :1292 and shadows a repository named "settings"
// identically (the teams/labels precedent; a non-owner's hit 404-shells at
// the handler, upstream's RequireOwner OrgAssignment NotFound). No other
// registration can absorb the deeper literals: /:owner/:repo/settings (the
// repo family) needs the literal third segment, and no registered
// /:owner/:repo/{X} line carries rename/delete/visibility/avatar as X.
uiRouter.get("/:owner/settings", (c) => orgSettingsPage(c));
uiRouter.post("/:owner/settings", (c) => orgSettingsSubmit(c));
uiRouter.post("/:owner/settings/avatar", (c) => orgSettingsAvatarSubmit(c));
uiRouter.get("/:owner/settings/avatar", () => methodNotAllowed("POST"));
uiRouter.post("/:owner/settings/avatar/delete", (c) => orgSettingsAvatarDeleteSubmit(c));
uiRouter.get("/:owner/settings/avatar/delete", () => methodNotAllowed("POST"));
uiRouter.post("/:owner/settings/rename", (c) => orgSettingsRenameSubmit(c));
uiRouter.get("/:owner/settings/rename", () => methodNotAllowed("POST"));
uiRouter.post("/:owner/settings/delete", (c) => orgSettingsDeleteSubmit(c));
uiRouter.get("/:owner/settings/delete", () => methodNotAllowed("POST"));
uiRouter.post("/:owner/settings/visibility", (c) => orgSettingsVisibilitySubmit(c));
uiRouter.get("/:owner/settings/visibility", () => methodNotAllowed("POST"));
// Wave-53 org settings hooks tab (parseUiRoute claims exactly these
// shapes — web.go:1033-1044's /hooks group). No earlier registration can
// absorb these: /:owner/settings/hooks is a 4-segment literal-second
// shape (every /:owner/:repo/settings* line needs FIVE segments, and no
// other 4-segment line carries a "settings" second segment), the {id}
// tails are deeper still, and the GET on the POST-only delete tail
// answers chi's 405 (the repo hooks-family convention).
uiRouter.get("/:owner/settings/hooks", (c) => orgHooksSettingsPage(c));
uiRouter.post("/:owner/settings/hooks", (c) => orgHooksSettingsSubmit(c));
uiRouter.get("/:owner/settings/hooks/:id", (c) => orgHookDetailPage(c));
uiRouter.post("/:owner/settings/hooks/:id", (c) => orgHookDetailSubmit(c));
uiRouter.post("/:owner/settings/hooks/:id/delete", (c) => orgHookDeleteSubmit(c));
// Window-2b: the blocked_users tab + the actions sub-tabs.
uiRouter.get("/:owner/settings/blocked_users", (c) => orgBlockedUsersPage(c));
uiRouter.post("/:owner/settings/blocked_users", (c) => orgBlockedUsersSubmit(c));
uiRouter.get("/:owner/settings/actions/secrets", (c) => orgActionsSecretsPage(c));
uiRouter.post("/:owner/settings/actions/secrets", (c) => orgActionsSecretsSubmit(c));
uiRouter.post("/:owner/settings/actions/secrets/delete", (c) => orgActionsSecretsDelete(c));
uiRouter.get("/:owner/settings/actions/variables", (c) => orgActionsVariablesPage(c));
uiRouter.post("/:owner/settings/actions/variables/new", (c) => orgActionsVariablesNew(c));
uiRouter.post("/:owner/settings/actions/variables/:id/edit", (c) => orgActionsVariablesEdit(c, Number(c.req.param("id"))));
uiRouter.post("/:owner/settings/actions/variables/:id/delete", (c) => orgActionsVariablesDelete(c, Number(c.req.param("id"))));
// The census C7 org arm: the runners sub-tab (parseUiRoute claims exactly
// these shapes — web.go:1058's addSettingsRunnersRoutes at the org scope,
// the require-owner prologue as the gate). No earlier registration can
// absorb these: the `settings` second segment is the org block's static, the
// `runners` tail literals are deeper still, and the GETs on the POST-only
// tails answer chi's 405 (the repo runners-family convention).
uiRouter.get("/:owner/settings/actions/runners", (c) => orgActionsRunnersPage(c));
uiRouter.post("/:owner/settings/actions/runners", () => methodNotAllowed("GET"));
uiRouter.get("/:owner/settings/actions/runners/reset_registration_token", () => methodNotAllowed("POST"));
uiRouter.post("/:owner/settings/actions/runners/reset_registration_token", (c) => orgActionsRunnersTokenReset(c));
uiRouter.get("/:owner/settings/actions/runners/:id", (c) => orgActionsRunnerEditPage(c, Number(c.req.param("id"))));
uiRouter.post("/:owner/settings/actions/runners/:id", (c) => orgActionsRunnerEditSubmit(c, Number(c.req.param("id"))));
uiRouter.get("/:owner/settings/actions/runners/:id/update-runner", () => methodNotAllowed("POST"));
uiRouter.post("/:owner/settings/actions/runners/:id/update-runner", (c) => orgActionsRunnerUpdate(c, Number(c.req.param("id"))));
uiRouter.get("/:owner/settings/actions/runners/:id/delete", () => methodNotAllowed("POST"));
uiRouter.post("/:owner/settings/actions/runners/:id/delete", (c) => orgActionsRunnerDelete(c, Number(c.req.param("id"))));
// The census R20 (a) arm: the applications tab (parseUiRoute claims exactly
// these shapes — web.go:1027-1037's /applications group: the bare list GET,
// the create POST, the {id}/delete write). No earlier registration can
// absorb these: /:owner/settings/applications is a 4-segment
// literal-second shape (every /:owner/:repo/settings* line needs FIVE
// segments), the /oauth2 tails are deeper still, and the GETs on the
// POST-only tails answer chi's 405 (the hooks-family convention). The
// /oauth2/{id} show/edit + regenerate_secret shapes stay UNREGISTERED →
// the engine's 404 (no landed edit page — the module header's reduction).
uiRouter.get("/:owner/settings/applications", (c) => orgApplicationsPage(c));
uiRouter.post("/:owner/settings/applications/oauth2", (c) => orgApplicationsCreateSubmit(c));
uiRouter.get("/:owner/settings/applications/oauth2", () => methodNotAllowed("POST"));
uiRouter.post("/:owner/settings/applications/oauth2/:id/delete", (c) => orgApplicationsDeleteSubmit(c, Number(c.req.param("id"))));
uiRouter.get("/:owner/settings/applications/oauth2/:id/delete", () => methodNotAllowed("POST"));
// The R20 +audit_logs arm / census R13 org mount (parseUiRoute claims
// exactly the 4-segment literal — web.go:1069's GET-only page; the POST
// answers chi's 405, the compare family's convention).
uiRouter.get("/:owner/settings/audit_logs", (c) => orgAuditLogsPage(c));
uiRouter.post("/:owner/settings/audit_logs", () => methodNotAllowed("GET"));
// Window-2c: the admin group.
uiRouter.get("/-/admin", (c) => adminDashboardPage(c));
uiRouter.post("/-/admin", (c) => adminDashboardSubmit(c));
uiRouter.get("/-/admin/monitor/stats", (c) => adminMonitorPage(c, "stats"));
uiRouter.get("/-/admin/monitor/cron", (c) => adminMonitorPage(c, "cron"));
uiRouter.post("/-/admin/monitor/cron", (c) => adminMonitorCronSubmit(c));
uiRouter.get("/-/admin/monitor/queue", (c) => adminMonitorPage(c, "queue"));
uiRouter.get("/-/admin/monitor/stacktrace", (c) => adminMonitorPage(c, "trace"));
// The admin listing pages (top-level static literals — nothing dynamic
// shadows them; the parse claims carry the same literals).
uiRouter.get("/-/admin/users", (c) => adminUsersPage(c));
uiRouter.get("/-/admin/orgs", (c) => adminOrgsPage(c));
uiRouter.get("/-/admin/repos", (c) => adminReposPage(c));
// The tick-18 packages arm (parseUiRoute claims exactly the bare literal —
// web.go:852-858's list GET; the group's delete/cleanup POSTs stay
// unregistered, the engine's 404).
uiRouter.get("/-/admin/packages", (c) => adminPackagesPage(c));
// The census R18 (a) arms (parseUiRoute claims exactly these shapes — the
// same static literals; the writes are POST-only, the badge slug families
// ride the decoded param, the application delete the positive-integer id).
uiRouter.get("/-/admin/emails", (c) => adminEmailsPage(c));
uiRouter.post("/-/admin/emails/activate", (c) => adminEmailsActivate(c));
uiRouter.post("/-/admin/emails/delete", (c) => adminEmailsDelete(c));
uiRouter.get("/-/admin/hooks", (c) => adminHooksPage(c));
uiRouter.post("/-/admin/hooks/delete", (c) => adminHooksDelete(c));
uiRouter.get("/-/admin/badges", (c) => adminBadgesPage(c));
uiRouter.get("/-/admin/badges/new", (c) => adminBadgeNewPage(c));
uiRouter.post("/-/admin/badges/new", (c) => adminBadgeNewSubmit(c));
uiRouter.get("/-/admin/badges/slug/:slug", (c) => adminBadgeViewPage(c, c.req.param("slug")));
uiRouter.get("/-/admin/badges/slug/:slug/edit", (c) => adminBadgeEditPage(c, c.req.param("slug")));
uiRouter.post("/-/admin/badges/slug/:slug/edit", (c) => adminBadgeEditSubmit(c, c.req.param("slug")));
uiRouter.post("/-/admin/badges/slug/:slug/delete", (c) => adminBadgeDeleteSubmit(c, c.req.param("slug")));
uiRouter.get("/-/admin/badges/slug/:slug/users", (c) => adminBadgeUsersPage(c, c.req.param("slug"), null, ""));
uiRouter.post("/-/admin/badges/slug/:slug/users", (c) => adminBadgeUsersAdd(c, c.req.param("slug")));
uiRouter.post("/-/admin/badges/slug/:slug/users/delete", (c) => adminBadgeUsersDelete(c, c.req.param("slug")));
uiRouter.get("/-/admin/applications", (c) => adminApplicationsPage(c));
uiRouter.post("/-/admin/applications/oauth2", (c) => adminApplicationCreate(c));
uiRouter.post("/-/admin/applications/oauth2/:id{\\d+}/delete", (c) => adminApplicationDelete(c, Number.parseInt(c.req.param("id"), 10)));
// The SPEC-0018 §3.1 notices arm (parseUiRoute claims exactly these shapes —
// the same static literals; the writes are POST-only).
uiRouter.get("/-/admin/notices", (c) => adminNoticesPage(c));
uiRouter.post("/-/admin/notices/delete", (c) => adminNoticesDelete(c));
uiRouter.post("/-/admin/notices/empty", (c) => adminNoticesEmpty(c));
// The SPEC-0018 §3.2 config arm (parseUiRoute claims exactly the bare
// literal — web.go:788-794's GET-only summary beside the notices lines).
// Upstream's ChangeConfig POST is the §3.2 §-out: no POST twin exists, the
// unregistered method falls to the sub-app's 404 (never a page render).
uiRouter.get("/-/admin/config", (c) => adminConfigPage(c));
// The census C6 arm: the admin actions job queue (pages/repo-actions-queue.tsx
// — web.go:904's `GET /actions/job_queue`; the group's bare /actions literal
// and its runners/variables/scoped-workflows tails stay unregistered — the
// admin pages are not landed, the engine's 404). GET-only upstream — a POST
// answers chi's 405.
uiRouter.get("/-/admin/actions/job_queue", (c) => adminActionsJobQueuePage(c));
uiRouter.post("/-/admin/actions/job_queue", () => methodNotAllowed("GET"));
// The admin actions group's runners/variables families + the bare group
// redirect (static literals before the dynamic {id} arms; the POST-only
// shapes' GET twins answer chi's 405).
uiRouter.get("/-/admin/actions", (c) => adminActionsGroupRedirect(c));
uiRouter.get("/-/admin/actions/runners", (c) => adminActionsRunnersPage(c));
uiRouter.post("/-/admin/actions/runners/reset_registration_token", (c) => adminActionsRunnersTokenReset(c));
uiRouter.get("/-/admin/actions/runners/reset_registration_token", () => methodNotAllowed("POST"));
uiRouter.post("/-/admin/actions/runners/bulk", (c) => adminActionsRunnersBulk(c));
uiRouter.get("/-/admin/actions/runners/bulk", () => methodNotAllowed("POST"));
uiRouter.get("/-/admin/actions/runners/:id{(\\d+)}", (c) => adminActionsRunnerEditPage(c, Number.parseInt(c.req.param("id") ?? "0", 10)));
uiRouter.post("/-/admin/actions/runners/:id{(\\d+)}", (c) => adminActionsRunnerEditSubmit(c, Number.parseInt(c.req.param("id") ?? "0", 10)));
uiRouter.post("/-/admin/actions/runners/:id{(\\d+)}/update-runner", (c) => adminActionsRunnerUpdate(c, Number.parseInt(c.req.param("id") ?? "0", 10)));
uiRouter.get("/-/admin/actions/runners/:id{(\\d+)}/update-runner", () => methodNotAllowed("POST"));
uiRouter.post("/-/admin/actions/runners/:id{(\\d+)}/delete", (c) => adminActionsRunnerDelete(c, Number.parseInt(c.req.param("id") ?? "0", 10)));
uiRouter.get("/-/admin/actions/runners/:id{(\\d+)}/delete", () => methodNotAllowed("POST"));
uiRouter.get("/-/admin/actions/variables", (c) => adminActionsVariablesPage(c));
uiRouter.post("/-/admin/actions/variables/new", (c) => adminActionsVariableCreate(c));
uiRouter.get("/-/admin/actions/variables/new", () => methodNotAllowed("POST"));
uiRouter.post("/-/admin/actions/variables/:id{(\\d+)}/edit", (c) => adminActionsVariableEdit(c, Number.parseInt(c.req.param("id") ?? "0", 10)));
uiRouter.get("/-/admin/actions/variables/:id{(\\d+)}/edit", () => methodNotAllowed("POST"));
uiRouter.post("/-/admin/actions/variables/:id{(\\d+)}/delete", (c) => adminActionsVariableDelete(c, Number.parseInt(c.req.param("id") ?? "0", 10)));
uiRouter.get("/-/admin/actions/variables/:id{(\\d+)}/delete", () => methodNotAllowed("POST"));
// The POST-only shapes' GET twins answer the methodNotAllowed arm (the
// method-blind parse convention — upstream chi's own 405 posture).
uiRouter.get("/-/admin/emails/activate", () => methodNotAllowed("POST"));
uiRouter.get("/-/admin/emails/delete", () => methodNotAllowed("POST"));
uiRouter.get("/-/admin/hooks/delete", () => methodNotAllowed("POST"));
uiRouter.get("/-/admin/badges/slug/:slug/delete", () => methodNotAllowed("POST"));
uiRouter.get("/-/admin/badges/slug/:slug/users/delete", () => methodNotAllowed("POST"));
uiRouter.get("/-/admin/applications/oauth2", () => methodNotAllowed("POST"));
uiRouter.get("/-/admin/applications/oauth2/:id{\\d+}/delete", () => methodNotAllowed("POST"));
uiRouter.get("/-/admin/notices/delete", () => methodNotAllowed("POST"));
uiRouter.get("/-/admin/notices/empty", () => methodNotAllowed("POST"));
uiRouter.get("/:owner/settings/hooks/:id/delete", () => methodNotAllowed("POST"));
// Wave-14 org labels family (parseUiRoute claims exactly these shapes; the
// literal `labels` registers with the wave-9/12 statics so it beats the
// dynamic /:owner/:repo pair — the wave-9 RegExpRouter note). The three
// POST-only write tails answer GET with chi's 405.
uiRouter.get("/:owner/labels", (c) => orgLabelsPage(c));
uiRouter.post("/:owner/labels/new", (c) => orgLabelNewSubmit(c));
uiRouter.get("/:owner/labels/new", () => methodNotAllowed("POST"));
uiRouter.post("/:owner/labels/edit", (c) => orgLabelEditSubmit(c));
uiRouter.get("/:owner/labels/edit", () => methodNotAllowed("POST"));
uiRouter.post("/:owner/labels/delete", (c) => orgLabelDeleteSubmit(c));
uiRouter.get("/:owner/labels/delete", () => methodNotAllowed("POST"));
uiRouter.get("/:owner/:repo", (c) => uiPage(c));
uiRouter.get("/:owner/:repo/commits", (c) => uiPage(c));
uiRouter.get("/:owner/:repo/commits/*", (c) => uiPage(c));
// The census R09-M2 commit-graph family (parseUiRoute claims exactly the
// bare literal — web.go:1737-1744's GET-only page beside the commits group;
// no ref-suffix wildcard exists upstream, so the single line is exact —
// deeper /graph/* tails stay engine-owned).
uiRouter.get("/:owner/:repo/graph", (c) => repoGraphPage(c));
uiRouter.get("/:owner/:repo/src", (c) => uiPage(c));
uiRouter.get("/:owner/:repo/src/*", (c) => uiPage(c));
// The blame family (web.go:1729-1733): the typed tails only — the parser
// leaves the bare /blame engine-owned, so the wildcard registration must
// not claim wider than the parser (the uiPage drift guard 404s it).
uiRouter.get("/:owner/:repo/blame/*", (c) => uiPage(c));
// Wave-2 families (parseUiRoute claims exactly these shapes).
uiRouter.get("/:owner/:repo/tree", (c) => uiPage(c));
uiRouter.get("/:owner/:repo/tree/*", (c) => uiPage(c));
uiRouter.get("/:owner/:repo/issues", (c) => uiPage(c));
// The static literal registers before the dynamic :index so handler choice
// never depends on router precedence subtleties (Hono's RegExpRouter ranks
// static segments first; this makes it local and obvious).
uiRouter.get("/:owner/:repo/issues/new/choose", (c) => issueNewChoosePage(c));
uiRouter.get("/:owner/:repo/issues/new", (c) => issueNewPage(c));
uiRouter.post("/:owner/:repo/issues/new", (c) => issueNewSubmit(c));
// Window-2e B2 statics — hoisted ABOVE the /:index catch (hono honors
// registration order; the late spot left both feeds dead in uiPage's drift
// guard — the aux-fragments matrix's RED; the FOURTH registration-order
// catch: wiki #11, repo/search #15, pulls/new #17, these).
uiRouter.get("/:owner/:repo/issues/search", (c) => issuesSearchAuxRoute(c));
uiRouter.get("/:owner/:repo/issues/suggestions", (c) => issuesSuggestionsAuxRoute(c));
// Wave-5 label-write family — same static-before-dynamic rule (the bare
// /issues/labels shape would otherwise be absorbed by issues/:index).
uiRouter.post("/:owner/:repo/issues/labels", (c) => issueLabelsSubmit(c));
uiRouter.get("/:owner/:repo/issues/labels", () => methodNotAllowed("POST"));
// Wave-11 review-write literals — the SAME static-before-dynamic rule (the
// wave-9 RegExpRouter note: a static registered after the dynamic :index
// LOSES to it). POSTs run the §2.8 sameOriginGuard; GET answers chi's 405.
uiRouter.post("/:owner/:repo/issues/request_review", (c) => pullReviewRequestSubmit(c));
uiRouter.get("/:owner/:repo/issues/request_review", () => methodNotAllowed("POST"));
uiRouter.post("/:owner/:repo/issues/dismiss_review", (c) => pullReviewDismissSubmit(c));
uiRouter.get("/:owner/:repo/issues/dismiss_review", () => methodNotAllowed("POST"));
uiRouter.get("/:owner/:repo/issues/:index", (c) => uiPage(c));
uiRouter.get("/:owner/:repo/pulls", (c) => uiPage(c));
// Wave-29 diffpatch downloads (parseUiRoute claims exactly the dotted
// `\\d+.{diff|patch}` tail — upstream web.go:1657-1658). The narrow dotted
// pattern registers BEFORE the broad :index line so first-match-wins keeps
// the undotted shapes with the page dispatch (verified against this Hono
// pin's getPattern greedy-brace regex; unclaimed shapes never reach the
// sub-app — the dispatcher consults handlesUiRoute first).
uiRouter.get("/:owner/:repo/pulls/:dpindex{(\\d+)\\.(?:diff|patch)}", (c) => diffpatchFileDownload(c));
uiRouter.get("/:owner/:repo/pulls/:index", (c) => uiPage(c));
// Wave-5 write/read families (parseUiRoute claims exactly these shapes;
// the POSTs run the §2.8 sameOriginGuard first — session.ts's convention).
// The POST-only families answer GET with chi's 405 (registered so the
// sub-app's reach equals handlesUiRoute's).
uiRouter.post("/:owner/:repo/issues/:index/comments", (c) => issueCommentSubmit(c));
uiRouter.post("/:owner/:repo/pulls/:index/comments", (c) => issueCommentSubmit(c));
uiRouter.get("/:owner/:repo/issues/:index/comments", () => methodNotAllowed("POST"));
uiRouter.get("/:owner/:repo/pulls/:index/comments", () => methodNotAllowed("POST"));
uiRouter.get("/:owner/:repo/pulls/:index/files", (c) => uiPage(c));
// The PR commits tab (parseUiRoute claims exactly this shape — GET only,
// like every read page).
uiRouter.get("/:owner/:repo/pulls/:index/commits", (c) => uiPage(c));
// Wave-11 verdict-form family (the deeper 4-segment tail under /files — no
// shorter POST/GET pattern can absorb it; the GET answers chi's 405).
	uiRouter.post("/:owner/:repo/pulls/:index/files/reviews/submit", (c) => pullReviewSubmit(c));
	uiRouter.get("/:owner/:repo/pulls/:index/files/reviews/submit", () => methodNotAllowed("POST"));
	// Wave-13 compare family (parseUiRoute claims exactly these shapes; the
	// bare URL is GET-only — upstream registers `m.Get("/compare")` outside
	// the POST path group, so a POST answers chi's 405 — and the form always
	// posts to the basehead URL). The POST runs the §2.8 sameOriginGuard.
	uiRouter.get("/:owner/:repo/compare", (c) => comparePage(c));
	uiRouter.post("/:owner/:repo/compare", () => methodNotAllowed("GET"));
	uiRouter.get("/:owner/:repo/compare/*", (c) => comparePage(c));
	uiRouter.post("/:owner/:repo/compare/*", (c) => compareSubmit(c));
// Wave-4 write families (parseUiRoute claims exactly these shapes; the
// POSTs run the §2.8 sameOriginGuard first — session.ts's convention).
uiRouter.get("/:owner/:repo/settings", (c) => settingsPage(c));
// Window-2d: the four settings tabs.
uiRouter.get("/:owner/:repo/settings/hooks/git", (c) => repoGitHooksPage(c));
uiRouter.get("/:owner/:repo/settings/hooks/git/:name", (c) => repoGitHookEditPage(c));
uiRouter.post("/:owner/:repo/settings/hooks/git/:name", (c) => repoGitHookSubmit(c));
uiRouter.get("/:owner/:repo/settings/tags", (c) => repoTagsPage(c));
uiRouter.post("/:owner/:repo/settings/tags", (c) => repoTagsSubmit(c));
uiRouter.post("/:owner/:repo/settings/tags/delete", (c) => repoTagDeleteSubmit(c));
uiRouter.get("/:owner/:repo/settings/tags/:id", (c) => repoTagDetailPage(c));
uiRouter.post("/:owner/:repo/settings/tags/:id", (c) => repoTagsSubmit(c));
uiRouter.get("/:owner/:repo/settings/keys", (c) => repoDeployKeysPage(c));
uiRouter.post("/:owner/:repo/settings/keys", (c) => repoDeployKeysSubmit(c));
uiRouter.post("/:owner/:repo/settings/keys/delete", (c) => repoDeployKeysDelete(c));
uiRouter.get("/:owner/:repo/settings/public_access", (c) => repoPublicAccessPage(c));
uiRouter.post("/:owner/:repo/settings/public_access", (c) => repoPublicAccessSubmit(c));
uiRouter.get("/:owner/:repo/settings/wiki", (c) => repoWikiSettingsPage(c));
uiRouter.post("/:owner/:repo/settings/wiki", (c) => repoWikiSettingsSubmit(c));
// The census R11 LFS settings family (parseUiRoute claims exactly these four
// GET shapes — web.go:1249-1261's read surfaces). The POST twins answer
// chi's 405 (the audit arm's convention — read-only pages, no write arm).
uiRouter.get("/:owner/:repo/settings/lfs", (c) => repoLfsListPage(c));
uiRouter.post("/:owner/:repo/settings/lfs", () => methodNotAllowed("GET"));
uiRouter.get("/:owner/:repo/settings/lfs/show/:name", (c) => repoLfsDetailPage(c));
uiRouter.post("/:owner/:repo/settings/lfs/show/:name", () => methodNotAllowed("GET"));
uiRouter.get("/:owner/:repo/settings/lfs/pointers", (c) => repoLfsPointersPage(c));
uiRouter.post("/:owner/:repo/settings/lfs/pointers", () => methodNotAllowed("GET"));
uiRouter.get("/:owner/:repo/settings/lfs/find", (c) => repoLfsFindPage(c));
uiRouter.post("/:owner/:repo/settings/lfs/find", () => methodNotAllowed("GET"));
// The census R13 audit arm (parseUiRoute claims exactly the 5-segment
// literal — web.go:1279's GET-only page; the POST answers chi's 405, the
// compare family's methodNotAllowed convention).
uiRouter.get("/:owner/:repo/settings/audit_logs", (c) => repoAuditLogsPage(c));
uiRouter.post("/:owner/:repo/settings/audit_logs", () => methodNotAllowed("GET"));
// The census C8 arm: the repo settings Actions secrets/variables sub-tabs
// (upstream web.go:1269-1270's shared builders under the /actions group).
// The bare /settings/actions (upstream's LocationRedirect onto the unlanded
// general tab) stays unregistered — the engine's 404 (the org twin's
// posture). GET-only upstream tails answer the 405 (the audit arm's
// convention); the variable path ids ride the parse guard (junk ids never
// reach the handlers).
uiRouter.get("/:owner/:repo/settings/actions/secrets", (c) => repoActionsSecretsPage(c));
uiRouter.post("/:owner/:repo/settings/actions/secrets", (c) => repoActionsSecretsSubmit(c));
uiRouter.get("/:owner/:repo/settings/actions/secrets/delete", () => methodNotAllowed("POST"));
uiRouter.post("/:owner/:repo/settings/actions/secrets/delete", (c) => repoActionsSecretsDelete(c));
uiRouter.get("/:owner/:repo/settings/actions/variables", (c) => repoActionsVariablesPage(c));
uiRouter.post("/:owner/:repo/settings/actions/variables", () => methodNotAllowed("GET"));
uiRouter.get("/:owner/:repo/settings/actions/variables/new", () => methodNotAllowed("POST"));
uiRouter.post("/:owner/:repo/settings/actions/variables/new", (c) => repoActionsVariablesNew(c));
uiRouter.get("/:owner/:repo/settings/actions/variables/:id/edit", () => methodNotAllowed("POST"));
uiRouter.post("/:owner/:repo/settings/actions/variables/:id/edit", (c) => repoActionsVariablesEdit(c, Number(c.req.param("id"))));
uiRouter.get("/:owner/:repo/settings/actions/variables/:id/delete", () => methodNotAllowed("POST"));
uiRouter.post("/:owner/:repo/settings/actions/variables/:id/delete", (c) => repoActionsVariablesDelete(c, Number(c.req.param("id"))));
// The census C7 arm: the repo settings Actions runners sub-tab (upstream
// web.go:506-513's addSettingsRunnersRoutes). The literal reset tail
// registers before the :id combo (the static-before-dynamic rule — the same
// literal-second shape is a param match otherwise); the combo is GET+POST
// (upstream's m.Combo); the POST-only write tails answer GET with chi's 405.
uiRouter.get("/:owner/:repo/settings/actions/runners", (c) => repoActionsRunnersPage(c));
uiRouter.post("/:owner/:repo/settings/actions/runners", () => methodNotAllowed("GET"));
uiRouter.get("/:owner/:repo/settings/actions/runners/reset_registration_token", () => methodNotAllowed("POST"));
uiRouter.post("/:owner/:repo/settings/actions/runners/reset_registration_token", (c) => repoActionsRunnersTokenReset(c));
uiRouter.get("/:owner/:repo/settings/actions/runners/:id", (c) => repoActionsRunnerEditPage(c, Number(c.req.param("id"))));
uiRouter.post("/:owner/:repo/settings/actions/runners/:id", (c) => repoActionsRunnerEditSubmit(c, Number(c.req.param("id"))));
uiRouter.get("/:owner/:repo/settings/actions/runners/:id/update-runner", () => methodNotAllowed("POST"));
uiRouter.post("/:owner/:repo/settings/actions/runners/:id/update-runner", (c) => repoActionsRunnerUpdate(c, Number(c.req.param("id"))));
uiRouter.get("/:owner/:repo/settings/actions/runners/:id/delete", () => methodNotAllowed("POST"));
uiRouter.post("/:owner/:repo/settings/actions/runners/:id/delete", (c) => repoActionsRunnerDelete(c, Number(c.req.param("id"))));
// The census C9 arm: the repo settings Actions general sub-tab (upstream
// web.go:1262-1278). The bare literal's GET is the redirect; the general
// page is the GET side of the combo, the actions_unit write its POST-only
// tail (the GET twin answers chi's 405, the audit arm's convention).
uiRouter.get("/:owner/:repo/settings/actions", (c) => repoActionsSettingsRedirect(c));
uiRouter.post("/:owner/:repo/settings/actions", () => methodNotAllowed("GET"));
uiRouter.get("/:owner/:repo/settings/actions/general", (c) => repoActionsGeneralPage(c));
uiRouter.post("/:owner/:repo/settings/actions/general", () => methodNotAllowed("POST"));
uiRouter.get("/:owner/:repo/settings/actions/general/actions_unit", () => methodNotAllowed("POST"));
uiRouter.post("/:owner/:repo/settings/actions/general/actions_unit", (c) => repoActionsUnitSubmit(c));
// Window-2e pass 1: sitemap + search aux.
uiRouter.get("/sitemap.xml", (c) => sitemapRoute(c));
uiRouter.get("/explore/repos/sitemap-:file", (c) => sitemapRoute(c));
uiRouter.get("/explore/users/sitemap-:file", (c) => sitemapRoute(c));
uiRouter.post("/repo/migrate", (c) => repoMigrateSubmit(c));
uiRouter.get("/explore/topics/search", (c) => topicSearchAuxRoute(c));
// The feed suffixes — one constrained registration (the owner-home
// precedent); the parser discriminates .rss vs .atom and strips.
uiRouter.get("/:owner{^[\\w-]+\\.(rss|atom)$}", (c) => userFeedRoute(c));
// The repo feed twins — one constrained registration each (the user-feed
// one-constrained-registration convention); the parser discriminates .rss
// vs .atom by the dotted head. No existing 3-segment pattern matches a
// `releases.rss`/`tags.rss` second segment.
uiRouter.get("/:owner/:repo/:segment{^releases\\.(rss|atom)$}", (c) => releasesFeedRoute(c));
uiRouter.get("/:owner/:repo/:segment{^tags\\.(rss|atom)$}", (c) => tagsFeedRoute(c));
// Window-2e B2: the repo-scoped aux/fragment routes.
uiRouter.get("/:owner/:repo/:kind{issues|pulls}/:index{\\d+}/info", (c) => issueInfoFragmentRoute(c));
uiRouter.get("/:owner/:repo/:kind{issues|pulls}/:index{\\d+}/attachments", (c) => issueAttachmentsFragmentRoute(c));
uiRouter.get("/:owner/:repo/:kind{issues|pulls}/:index{\\d+}/attachments/:uuid", (c) => issueAttachmentsAliasRoute(c));
uiRouter.get("/:owner/:repo/:kind{issues|pulls}/:index{\\d+}/content-history/overview", (c) => issueContentOverviewRoute(c));
// The content-history list/detail dropdown arms (the same constrained-param
// form; the parser's numeric guard stays `-?\d+` — the registration's `\d+`
// is the info/overview precedent, aux-fragments.matrix pins the plain-404
// answer for `/issues/-1/...`).
uiRouter.get("/:owner/:repo/:kind{issues|pulls}/:index{\\d+}/content-history/list", (c) => issueContentHistoryListRoute(c));
uiRouter.get("/:owner/:repo/:kind{issues|pulls}/:index{\\d+}/content-history/detail", (c) => issueContentHistoryDetailRoute(c));
// The soft-delete write (parseUiRoute claims exactly this shape — the
// detail arm's tail with the soft-delete literal; POST-only upstream,
// web.go:1391's UPDATE group).
uiRouter.post("/:owner/:repo/:kind{issues|pulls}/:index{\\d+}/content-history/soft-delete", (c) => issueContentHistorySoftDeleteRoute(c));
uiRouter.get("/:owner/:repo/pulls/:index{\\d+}/merge_box", (c) => pullMergeBoxRoute(c));
uiRouter.get("/:owner/:repo/pulls/:index{\\d+}/files/:segment{^[a-f0-9]{7,64}(\\.\\.[a-f0-9]{7,64})?$}", (c) => pullFilesRangeRoute(c));
uiRouter.get("/:owner/:repo/pulls/:index{\\d+}/commits/:sha{^[a-f0-9]{7,64}$}", (c) => pullCommitFilesRoute(c));
uiRouter.get("/:owner/:repo/comments/:id/attachments", (c) => commentAttachmentsRoute(c));
uiRouter.get("/:owner/:repo/activity_author_data", (c) => activityAuthorDataRoute(c));
uiRouter.get("/:owner/:repo/activity_author_data/:period", (c) => activityAuthorDataRoute(c));
// The census R15 chart family (parseUiRoute claims exactly these six shapes
// — web.go:1633-1646's page + /data pairs). Registered ahead of the /:period
// line below: Hono's RegExpRouter gives static literals precedence over the
// param anyway, and the parser is the real gate (the drift guard makes any
// precedence regression a loud 404, the repo-charts matrix's first mount
// pin).
uiRouter.get("/:owner/:repo/activity/contributors", (c) => repoChartPage(c));
uiRouter.get("/:owner/:repo/activity/contributors/data", (c) => repoChartDataRoute(c));
uiRouter.get("/:owner/:repo/activity/code-frequency", (c) => repoChartPage(c));
uiRouter.get("/:owner/:repo/activity/code-frequency/data", (c) => repoChartDataRoute(c));
uiRouter.get("/:owner/:repo/activity/recent-commits", (c) => repoChartPage(c));
uiRouter.get("/:owner/:repo/activity/recent-commits/data", (c) => repoChartDataRoute(c));
// The census R14 repo activity page (parseUiRoute claims exactly these
// shapes — web.go:1628-1631's two page GETs). No existing 3-/4-segment line
// carries an `activity` literal third segment — the chart literals above
// claim first (the R15 family), and the wildcard-free pair is exact for the
// rest.
// The census C1 arm: the repo Actions runs list (pages/repo-actions-runs.tsx
// — web.go:1606-1608's group's `m.Get("", actions.List)`). The bare literal
// only; the sibling tails stay unclaimed (the family interface's note).
// GET-only upstream — a POST answers chi's 405 (the audit arm's convention).
uiRouter.get("/:owner/:repo/actions", (c) => repoActionsRunsPage(c));
uiRouter.post("/:owner/:repo/actions", () => methodNotAllowed("GET"));
// The census C6 arm: the repo Actions job queue (pages/repo-actions-queue.tsx
// — web.go:1570's group tail; the literal registers beside the runs list's
// bare literal, the same static-before-dynamic rule). GET-only upstream — a
// POST answers chi's 405 (the audit arm's convention).
uiRouter.get("/:owner/:repo/actions/job_queue", (c) => repoActionsJobQueuePage(c));
uiRouter.post("/:owner/:repo/actions/job_queue", () => methodNotAllowed("GET"));
// The census C2 arm: the run-viewer subtree (pages/repo-actions-view.tsx —
// web.go:1601-1605). The three view pairs share the ONE handler pair (the
// shape's params ride the family); the cancel POST is the C5-adjacent write,
// its GET answers chi's 405 (the audit arm's convention).
uiRouter.get("/:owner/:repo/actions/runs/:run", (c) => actionsRunViewPage(c));
uiRouter.post("/:owner/:repo/actions/runs/:run", (c) => actionsRunViewJson(c));
uiRouter.get("/:owner/:repo/actions/runs/:run/attempts/:attempt", (c) => actionsRunViewPage(c));
uiRouter.post("/:owner/:repo/actions/runs/:run/attempts/:attempt", (c) => actionsRunViewJson(c));
uiRouter.get("/:owner/:repo/actions/runs/:run/jobs/:job", (c) => actionsRunViewPage(c));
uiRouter.post("/:owner/:repo/actions/runs/:run/jobs/:job", (c) => actionsRunViewJson(c));
uiRouter.get("/:owner/:repo/actions/runs/:run/cancel", () => methodNotAllowed("POST"));
uiRouter.post("/:owner/:repo/actions/runs/:run/cancel", (c) => actionsRunCancel(c));
// The census C4 artifacts preview subtree (GET-only upstream — the POST
// twins answer chi's 405): the SSR file browser + the signed raw serving.
uiRouter.get("/:owner/:repo/actions/artifacts/:id/preview", (c) => actionsArtifactPreviewPage(c));
uiRouter.get("/:owner/:repo/actions/artifacts/:id/preview/*", (c) => actionsArtifactPreviewPage(c));
uiRouter.post("/:owner/:repo/actions/artifacts/:id/preview", () => methodNotAllowed("GET"));
uiRouter.post("/:owner/:repo/actions/artifacts/:id/preview/*", () => methodNotAllowed("GET"));
uiRouter.get("/-/actions/artifacts/:id/:expires/:signature", (c) => actionsArtifactPreviewRaw(c));
uiRouter.get("/-/actions/artifacts/:id/:expires/:signature/*", (c) => actionsArtifactPreviewRaw(c));
uiRouter.post("/-/actions/artifacts/:id/:expires/:signature", () => methodNotAllowed("GET"));
uiRouter.post("/-/actions/artifacts/:id/:expires/:signature/*", () => methodNotAllowed("GET"));
// The census C4 remainder: the runs-artifact download + delete (the first
// DELETE registration in the UI router — upstream web.go:1595-1596's pair).
uiRouter.get("/:owner/:repo/actions/runs/:run/artifacts/:name", (c) => actionsRunArtifactDownload(c));
uiRouter.delete("/:owner/:repo/actions/runs/:run/artifacts/:name", (c) => actionsRunArtifactDelete(c));
// The F-row tails (the survey's six, now all mounted): the job-scoped log
// download, the workflow-file redirect, the badge SVG, and the
// dispatch-modal inputs fragment — GET-only upstream, chi-405 POST twins.
uiRouter.get("/:owner/:repo/actions/runs/:run/jobs/:job/logs", (c) => actionsRunJobLogsRoute(c));
uiRouter.post("/:owner/:repo/actions/runs/:run/jobs/:job/logs", () => methodNotAllowed("GET"));
uiRouter.get("/:owner/:repo/actions/runs/:run/workflow", (c) => actionsRunWorkflowRoute(c));
uiRouter.post("/:owner/:repo/actions/runs/:run/workflow", () => methodNotAllowed("GET"));
uiRouter.get("/:owner/:repo/actions/workflows/:workflowName/badge.svg", (c) => repoActionsWorkflowBadgeRoute(c));
uiRouter.post("/:owner/:repo/actions/workflows/:workflowName/badge.svg", () => methodNotAllowed("GET"));
uiRouter.get("/:owner/:repo/actions/workflow-dispatch-inputs", (c) => repoActionsDispatchInputsRoute(c));
uiRouter.post("/:owner/:repo/actions/workflow-dispatch-inputs", () => methodNotAllowed("GET"));
uiRouter.get("/:owner/:repo/activity", (c) => repoActivityPage(c));
uiRouter.get("/:owner/:repo/activity/:period", (c) => repoActivityPage(c));
// Window-2e C1: the global inbox.
uiRouter.get("/issues", (c) => globalInboxIssuesPage(c, "issues"));
uiRouter.get("/pulls", (c) => globalInboxIssuesPage(c, "pulls"));
uiRouter.get("/milestones", (c) => globalMilestonesPage(c));
// Window-2e C2: the wiki family.
uiRouter.post("/:owner/:repo/settings", (c) => settingsSubmit(c));
uiRouter.get("/:owner/:repo/settings/hooks", (c) => hooksSettingsPage(c));
uiRouter.post("/:owner/:repo/settings/hooks", (c) => hooksSettingsSubmit(c));
// Wave-14 per-hook family (parseUiRoute claims exactly these shapes; the
// POSTs run the §2.8 sameOriginGuard first; the POST-only test/delete tails
// answer GET with chi's 405 — the comment/label write convention).
uiRouter.get("/:owner/:repo/settings/hooks/:id", (c) => hookDetailPage(c));
uiRouter.post("/:owner/:repo/settings/hooks/:id", (c) => hookDetailSubmit(c));
uiRouter.post("/:owner/:repo/settings/hooks/:id/test", (c) => hookTestSubmit(c));
uiRouter.get("/:owner/:repo/settings/hooks/:id/test", () => methodNotAllowed("POST"));
uiRouter.post("/:owner/:repo/settings/hooks/:id/delete", (c) => hookDeleteSubmit(c));
uiRouter.get("/:owner/:repo/settings/hooks/:id/delete", () => methodNotAllowed("POST"));
// Wave-10 mirror panel (parseUiRoute claims exactly this shape; the same
// settings gate as the other two sub-pages).
uiRouter.get("/:owner/:repo/settings/mirror", (c) => mirrorSettingsPage(c));
uiRouter.post("/:owner/:repo/settings/mirror", (c) => mirrorSyncSubmit(c));
// Wave-15 protected-branches family (parseUiRoute claims exactly these
// shapes — upstream's web.go:1206-1212 group; the POSTs run the §2.8
// sameOriginGuard first; the POST-only write tails answer GET with chi's
// 405 — the hook test/delete convention).
/** POST /{owner}/{repo}/settings/branches — the default-branch write
 *  (upstream SetDefaultBranchPost over the landed RepoService.setDefaultBranch;
 *  pages/branch-protection.tsx's module header carries the arm citations). */
async function branchProtectionDefaultBranchSubmit(c: Context<{ Bindings: Env }>): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveUiRequest(c);
  if (!resolved.ok) return resolved.response;
  const gate = await settingsGate(c, resolved);
  if (gate !== null) return gate;
  const { ctx, repo, respond } = resolved;
  if (repo.isArchived) return respond(c.html(renderNotFound(ctx), 404)); // RepoMustNotBeArchived posture
  const form = await readUrlEncodedForm(c.req.raw);
  if (form.get("action") !== "default_branch") return respond(c.html(renderNotFound(ctx), 404)); // the switch's default arm
  const result = await applyDefaultBranchForm(c.env, repo, form.get("branch") ?? "");
  if (result.outcome === "missing") return respond(c.html(renderNotFound(ctx), 404)); // ErrBranchNotExist's 404
  return respond(
    new Response(null, { status: 303, headers: { location: `/${repo.ownerNamespace}/${repo.slug}/settings/branches` } }),
  );
}

uiRouter.get("/:owner/:repo/settings/branches", (c) => branchProtectionListPage(c));
uiRouter.post("/:owner/:repo/settings/branches", (c) => branchProtectionDefaultBranchSubmit(c));
uiRouter.get("/:owner/:repo/settings/branches/edit", (c) => branchProtectionEditPage(c));
uiRouter.post("/:owner/:repo/settings/branches/edit", (c) => branchProtectionEditSubmit(c));
uiRouter.post("/:owner/:repo/settings/branches/priority", (c) => branchProtectionPrioritySubmit(c));
uiRouter.get("/:owner/:repo/settings/branches/priority", () => methodNotAllowed("POST"));
uiRouter.post("/:owner/:repo/settings/branches/:id/delete", (c) => branchProtectionDeleteSubmit(c));
uiRouter.get("/:owner/:repo/settings/branches/:id/delete", () => methodNotAllowed("POST"));
// Wave-16 branches family (parseUiRoute claims exactly these shapes —
// upstream's web.go:1478-1482 group; the delete POST runs the §2.8
// sameOriginGuard first and answers GET with chi's 405 — the hook
// test/delete convention).
uiRouter.get("/:owner/:repo/branches", (c) => branchesPage(c));
uiRouter.post("/:owner/:repo/branches/delete", (c) => branchDeleteSubmit(c));
// Window-2e folds: the branch writer arms, the pulls/new redirect, the upload endpoints.
uiRouter.post("/:owner/:repo/branches/_new/*", (c) => branchCreateSubmit(c));
uiRouter.post("/:owner/:repo/branches/rename", (c) => branchRenameSubmit(c));
uiRouter.get("/:owner/:repo/pulls/new/*", (c) => pullsNewRedirect(c));
uiRouter.post("/:owner/:repo/upload-file", (c) => uploadFileEndpoint(c));
uiRouter.post("/:owner/:repo/upload-remove", (c) => uploadRemoveEndpoint(c));
uiRouter.get("/:owner/:repo/branches/delete", () => methodNotAllowed("POST"));
// Wave-29 diffpatch downloads (parseUiRoute claims exactly the dotted
// hex `{sha}.{diff|patch}` tail — upstream web.go:1760's RawDiff route).
// The narrow dotted pattern registers BEFORE the wave-18 broad :sha line so
// first-match-wins keeps the undotted shapes with the commit view (the
// pulls-pair registration note; `ABC.diff` misses the hex shape and lands
// in the commit view's 404-shell loader, upstream's pattern-miss answer).
uiRouter.get("/:owner/:repo/commit/:dpsha{[0-9a-f]{7,64}\\.(?:diff|patch)}", (c) => diffpatchFileDownload(c));
// Wave-18 commit-view family (parseUiRoute claims exactly the
// single-segment `{sha}` shape — upstream's web.go:1739 route; the
// ShortSha links every landed list page emits resolve from here).
uiRouter.get("/:owner/:repo/commit/:sha", (c) => commitViewPage(c));
// Wave-6 milestones families (parseUiRoute claims exactly these shapes; the
// static literal registers before any deeper dynamic tail could — there is
// none this slice, the shape is kept for the reasons above).
uiRouter.get("/:owner/:repo/milestones", (c) => milestonesPage(c));
uiRouter.get("/:owner/:repo/milestones/new", (c) => milestoneNewPage(c));
uiRouter.post("/:owner/:repo/milestones/new", (c) => milestoneNewSubmit(c));
// Wave-20 releases families (parseUiRoute claims exactly these shapes —
// upstream's web.go:1505-1514 group; the static literal tails register
// before the `/tag/*` catch-all so the precedence is local and obvious; the
// POST runs the §2.8 sameOriginGuard; the bare family carries GET only).
uiRouter.get("/:owner/:repo/releases", (c) => releasesPage(c));
uiRouter.get("/:owner/:repo/releases/new", (c) => releaseNewPage(c));
uiRouter.post("/:owner/:repo/releases/new", (c) => releaseNewSubmit(c));
uiRouter.get("/:owner/:repo/releases/latest", (c) => releaseLatestRedirect(c));
uiRouter.get("/:owner/:repo/releases/tag/*", (c) => releaseDetailPage(c));
// Wave-8 file editor families (parseUiRoute claims exactly these shapes; the
// POSTs run the §2.8 sameOriginGuard first — session.ts's convention; the
// `*` tail is the branch+path rest the handlers resolve against the branch
// universe). All three carry GET (the forms) + POST (the writes) — even the
// delete, whose confirmation page is where a failed CAS re-renders.
uiRouter.get("/:owner/:repo/new/*", (c) => fileEditorPage(c, "file-new"));
uiRouter.post("/:owner/:repo/new/*", (c) => fileEditorSubmit(c, "file-new"));
uiRouter.get("/:owner/:repo/edit/*", (c) => fileEditorPage(c, "file-edit"));
uiRouter.post("/:owner/:repo/edit/*", (c) => fileEditorSubmit(c, "file-edit"));
uiRouter.get("/:owner/:repo/delete/*", (c) => fileEditorPage(c, "file-delete"));
uiRouter.post("/:owner/:repo/delete/*", (c) => fileEditorSubmit(c, "file-delete"));
// Window-2e C2b: the upload + cherrypick/patch tails.
uiRouter.get("/:owner/:repo/upload/*", (c) => fileUploadPage(c));
uiRouter.post("/:owner/:repo/upload/*", (c) => fileUploadSubmit(c));
uiRouter.get("/:owner/:repo/patch/*", (c) => editorPatchPage(c, false));
uiRouter.post("/:owner/:repo/patch/*", (c) => editorPatchPage(c, true));
uiRouter.get("/:owner/:repo/cherrypick/*", (c) => editorCherryPickPage(c, false));
uiRouter.post("/:owner/:repo/cherrypick/*", (c) => editorCherryPickPage(c, true));
// Wave-6 single-segment family, wave-7-extended into the owner home (org
// rows → the org home, user rows → the user profile — upstream's
// OwnerProfile dispatch). The label regex is wave 6's VERBATIM (it already
// admits every name — user pages included — except TOP_LEVEL_EXCLUDED:
// /login + /logout are registered on the parent app AFTER this mount, so
// the dynamic shape would shadow them — verified Hono registration-order
// precedence; /healthz is the dispatcher's static route) so those requests
// miss this sub-app to their own routers. The parser stays the source of
// truth; the handler 404-shells any drift.
uiRouter.get("/:owner{^(?!login$|logout$|healthz$)[\\w.-]+$}", (c) => ownerHomePage(c));
// Wave-23 org families (parseUiRoute claims exactly these shapes —
// upstream's /org/{org}/members literal web.go:965 and the /{username}/-
// repositories route web.go:1134; appended at the physical tail because no
// registered pattern above can match them: the 3-segment shapes need a
// "members"/"repositories" tail no earlier family carries, the static
// "org"/"-" segments beat every dynamic peer, and the single-segment owner
// regex above is a different shape — so the tail registration keeps the
// sub-app's reach equal to the parser's, the drift guards absorbing any
// future collision loudly).
uiRouter.get("/org/:owner/members", (c) => orgMembersPage(c));
uiRouter.get("/:owner/-/repositories", (c) => orgRepositoriesPage(c));
// The owner heatmap JSON tail (parseUiRoute claims the exact 4-segment
// shape — the `-` namespace's disjoint literal; GET-only, the JSON feed).
uiRouter.get("/:owner/-/heatmap", (c) => ownerHeatmapData(c));
// The codesearch-M1 owner code-search page (parseUiRoute claims the exact
// 4-segment shape — the `-` namespace's disjoint literal beside the
// heatmap/repositories/projects tails; GET only, the page handler runs the
// session prologue like every GET page).
uiRouter.get("/:owner/-/code", (c) => userCodeSearchPage(c));
// The census R06 org dashboard (parseUiRoute claims exactly these shapes —
// upstream web.go:982-985's /org/{org}/dashboard + /org/{org}/dashboard/
// {team} literals; the wave-23 tail-spot rationale verbatim: the static
// "org"+"dashboard" segments carry no earlier pattern, the deeper :team
// tail is a 5-segment shape no registered line matches, and the member-only
// page 404-shells inside the handler).
uiRouter.get("/org/:owner/dashboard", (c) => orgDashboardPage(c));
uiRouter.get("/org/:owner/dashboard/:team", (c) => orgDashboardPage(c));
// Wave-24 repo social lists (parseUiRoute claims exactly these shapes —
// upstream's web.go:1759/1766/1767 bare literals; GET-only read pages
// through the uiPage dispatch, the branches/releases convention).
uiRouter.get("/:owner/:repo/forks", (c) => uiPage(c));
uiRouter.get("/:owner/:repo/stars", (c) => uiPage(c));
uiRouter.get("/:owner/:repo/watchers", (c) => uiPage(c));
// The census R10 code search page (parseUiRoute claims exactly this shape —
// upstream web.go:1768's bare /search literal registered in the same group
// as the social trio just above; GET-only read page over the engine's grep
// RPC, the dedicated-handler convention like repoActivityPage). No earlier
// registration can absorb it: every other 3-segment dynamic line carries a
// constrained or known literal third segment.
uiRouter.get("/:owner/:repo/search", (c) => repoSearchPage(c));
// Wave-24 collaboration panel (parseUiRoute claims exactly these shapes —
// upstream web.go:1194-1204's group; the POSTs run the §2.8 sameOriginGuard
// first and the four POST-only write tails answer GET with chi's 405 — the
// hook test/delete convention. No earlier registration can absorb these:
// /settings/collaboration/* is a deeper tail than every registered
// /settings family, and the static "collaboration" segment outranks any
// dynamic peer).
uiRouter.get("/:owner/:repo/settings/collaboration", (c) => collaborationPage(c));
uiRouter.post("/:owner/:repo/settings/collaboration", (c) => collaborationAddSubmit(c));
uiRouter.post("/:owner/:repo/settings/collaboration/access_mode", (c) => collaborationAccessModeSubmit(c));
uiRouter.get("/:owner/:repo/settings/collaboration/access_mode", () => methodNotAllowed("POST"));
uiRouter.post("/:owner/:repo/settings/collaboration/delete", (c) => collaborationDeleteSubmit(c));
uiRouter.get("/:owner/:repo/settings/collaboration/delete", () => methodNotAllowed("POST"));
uiRouter.post("/:owner/:repo/settings/collaboration/team", (c) => collaborationTeamAddSubmit(c));
uiRouter.get("/:owner/:repo/settings/collaboration/team", () => methodNotAllowed("POST"));
uiRouter.post("/:owner/:repo/settings/collaboration/team/delete", (c) => collaborationTeamDeleteSubmit(c));
uiRouter.get("/:owner/:repo/settings/collaboration/team/delete", () => methodNotAllowed("POST"));
// Wave-25 repo tags + labels families (parseUiRoute claims exactly these
// shapes — upstream's web.go:1493-1496 `/tags` list literal and
// web.go:1338's labels page + web.go:1417-1422's three POST write segments).
// The tags page rides the uiPage dispatch (the social-trio convention); the
// labels POSTs run the §2.8 sameOriginGuard first and the three POST-only
// write tails answer GET with chi's 405 (the org-labels convention). No
// earlier registration can absorb these: the bare "tags"/"labels" tails are
// distinct single literals no registered pattern carries, and the org
// /:owner/labels pair (SECOND-segment literal) never matches a three-segment
// /:owner/:repo shape.
uiRouter.get("/:owner/:repo/tags", (c) => uiPage(c));
uiRouter.get("/:owner/:repo/labels", (c) => repoLabelsPage(c));
uiRouter.post("/:owner/:repo/labels/new", (c) => repoLabelNewSubmit(c));
uiRouter.get("/:owner/:repo/labels/new", () => methodNotAllowed("POST"));
uiRouter.post("/:owner/:repo/labels/edit", (c) => repoLabelEditSubmit(c));
uiRouter.get("/:owner/:repo/labels/edit", () => methodNotAllowed("POST"));
uiRouter.post("/:owner/:repo/labels/delete", (c) => repoLabelDeleteSubmit(c));
uiRouter.get("/:owner/:repo/labels/delete", () => methodNotAllowed("POST"));
// Wave-45 repo projects (web.go:1544-1563 — pages/repo-projects.tsx): the
// literal list + the write group's /new combo + the numeric-{id} board,
// write and workflow shapes (chi static-before-dynamic — the literals
// register ahead of the params; the parser mirrors the order). The {repo}
// param carries the `[^-].*` constraint: a leading-dash segment is the
// owner namespace's (`/:owner/-/projects*`, the wave-37/40 families) and
// Hono must never route it here — the router-level twin of the parser's
// `repo === "-"` guard (upstream chi ranks the static `/-` group first; no
// landed slug starts with a dash, so the constraint claims nothing new).
// The PUT/DELETE/JSON board-helper arms stay unregistered, exactly upstream.
uiRouter.get("/:owner/:repo{[^-].*}/projects", (c) => repoProjectsPage(c));
uiRouter.get("/:owner/:repo{[^-].*}/projects/new", (c) => repoProjectNewPage(c));
uiRouter.post("/:owner/:repo{[^-].*}/projects/new", (c) => repoProjectNewSubmit(c));
uiRouter.get("/:owner/:repo{[^-].*}/projects/:id", (c) => repoProjectBoardPage(c));
uiRouter.get("/:owner/:repo{[^-].*}/projects/:id/edit", (c) => repoProjectEditPage(c));
uiRouter.post("/:owner/:repo{[^-].*}/projects/:id/edit", (c) => repoProjectEditSubmit(c));
uiRouter.post("/:owner/:repo{[^-].*}/projects/:id/delete", (c) => repoProjectDeleteSubmit(c));
uiRouter.get("/:owner/:repo{[^-].*}/projects/:id/delete", () => methodNotAllowed("POST"));
uiRouter.post("/:owner/:repo{[^-].*}/projects/:id/open", (c) => repoProjectStatusSubmit(c));
uiRouter.get("/:owner/:repo{[^-].*}/projects/:id/open", () => methodNotAllowed("POST"));
uiRouter.post("/:owner/:repo{[^-].*}/projects/:id/close", (c) => repoProjectStatusSubmit(c));
uiRouter.get("/:owner/:repo{[^-].*}/projects/:id/close", () => methodNotAllowed("POST"));
uiRouter.post("/:owner/:repo{[^-].*}/projects/:id/columns/new", (c) => repoProjectColumnNewSubmit(c));
uiRouter.get("/:owner/:repo{[^-].*}/projects/:id/columns/new", () => methodNotAllowed("POST"));
uiRouter.post("/:owner/:repo{[^-].*}/projects/:id/:columnId{\\d+}/default", (c) => repoProjectColumnDefaultSubmit(c));
uiRouter.get("/:owner/:repo{[^-].*}/projects/:id/:columnId{\\d+}/default", () => methodNotAllowed("POST"));
uiRouter.get("/:owner/:repo{[^-].*}/projects/:id/workflows", (c) => repoProjectWorkflowsPage(c));
uiRouter.post("/:owner/:repo{[^-].*}/projects/:id/workflows", (c) => repoProjectWorkflowCreateSubmit(c));
uiRouter.get("/:owner/:repo{[^-].*}/projects/:id/workflows/:wid", (c) => repoProjectWorkflowsPage(c));
uiRouter.post("/:owner/:repo{[^-].*}/projects/:id/workflows/:wid", (c) => repoProjectWorkflowUpdateSubmit(c));
uiRouter.post("/:owner/:repo{[^-].*}/projects/:id/workflows/:wid/delete", (c) => repoProjectWorkflowDeleteSubmit(c));
// The GET 405 twin — upstream mounts addProjectWorkflowRoutes (POST-only
// delete tail) identically in BOTH groups (web.go:1140-1155 owner,
// 1544-1563 repo); the owner twin has carried this since 9b49cd2, the
// wave-45 repo block stopped at the POST line (the projects matrix's RED).
uiRouter.get("/:owner/:repo{[^-].*}/projects/:id/workflows/:wid/delete", () => methodNotAllowed("POST"));
// Wave-26 milestone detail + edit + fork form (parseUiRoute claims exactly
// these shapes — upstream web.go:1340's singular reader route,
// web.go:1427-1428's `{id}/edit` writer combo (the shared labels-write gate
// runs at the handlers) and web.go:1490's fork combo (the signed-in gate +
// the empty-source 404 run at the handlers; the POSTs run the §2.8
// sameOriginGuard first). No earlier registration can absorb these: the
// singular "milestone" head is a distinct literal, "new" under /milestones
// registered long before the dynamic :id tail (a 5-segment shape no earlier
// pattern carries), and the singular "fork" never collides with the landed
// bare "forks" literal.
uiRouter.get("/:owner/:repo/milestone/:id", (c) => milestoneDetailPage(c));
uiRouter.get("/:owner/:repo/milestones/:id/edit", (c) => milestoneEditPage(c));
uiRouter.post("/:owner/:repo/milestones/:id/edit", (c) => milestoneEditSubmit(c));
uiRouter.get("/:owner/:repo/fork", (c) => repoForkPage(c));
uiRouter.post("/:owner/:repo/fork", (c) => repoForkSubmit(c));
// Wave-32 archive download + commit aux JSON (parseUiRoute claims exactly
// these shapes — upstream web.go:1689's `/archive/*` wildcard, its bare URL
// included (the empty-tail 400 arm), and web.go:1740's
// `{sha}/load-branches-and-tags` 5-segment route). No earlier registration
// can absorb these: the "archive"/"load-branches-and-tags" literals are
// distinct tails no registered pattern carries, the 5-segment shape is
// deeper than every /commit family (the 4-segment :sha line cannot match
// it), and unclaimed shapes never reach the sub-app — the dispatcher
// consults handlesUiRoute first. GET only: the archive POST half
// (InitiateDownload) stays engine-owned.
uiRouter.get("/:owner/:repo/archive/*", (c) => archiveFileDownload(c));
uiRouter.get("/:owner/:repo/archive", (c) => archiveFileDownload(c));
uiRouter.get("/:owner/:repo/commit/:lbsha/load-branches-and-tags", (c) => commitContainedRefsJson(c));
// Wave-33 tags tails + releases edit/delete (parseUiRoute claims exactly
// these shapes — upstream's web.go:1499 `/tags/list` aux literal, web.go:1501
// `/tags/delete` POST, web.go:1519-1520 `/releases/edit/*` combo and
// web.go:1523 `/releases/delete` POST; the POSTs run the §2.8
// sameOriginGuard first and the POST-only tails answer GET with chi's 405 —
// the hook test/delete convention; the edit combo carries GET + POST). No
// earlier registration can absorb these: the "list"/"delete" tails under
// /tags and /releases are literals no registered pattern carries (the
// wave-20 /releases/tag/* catch-all matches only the "tag" head), the
// 5-segment /releases/edit/* shape is deeper than every 4-segment releases
// line, and unclaimed shapes never reach the sub-app — the dispatcher
// consults handlesUiRoute first.
uiRouter.get("/:owner/:repo/tags/list", (c) => tagListAuxJson(c));
uiRouter.post("/:owner/:repo/tags/delete", (c) => tagsDeleteSubmit(c));
uiRouter.get("/:owner/:repo/tags/delete", () => methodNotAllowed("POST"));
uiRouter.get("/:owner/:repo/releases/edit/*", (c) => releaseEditPage(c));
uiRouter.post("/:owner/:repo/releases/edit/*", (c) => releaseEditSubmit(c));
uiRouter.post("/:owner/:repo/releases/delete", (c) => releaseDeleteSubmit(c));
uiRouter.get("/:owner/:repo/releases/delete", () => methodNotAllowed("POST"));
// Wave-37 owner projects list (parseUiRoute claims exactly this shape —
// upstream web.go:1143's read group, `m.Get("", org.Projects)`; GET only,
// the board depth and the write group stay unclaimed per the page module's
// scoping note). Appended at the physical tail per the wave-23 convention:
// the static "-" segment outranks every dynamic peer and no registered
// pattern above carries a 4-segment /:owner/-/projects shape.
uiRouter.get("/:owner/-/projects", (c) => ownerProjectsPage(c));
// Wave-39 aux fragments + blob redirect (parseUiRoute claims exactly these
// shapes — upstream web.go:1757's `/blob/*` redirect wildcard + its bare
// literal (the dispatcher's 404-shell arm, the wave-2 /tree pair's posture),
// web.go:1297-1306's three typed `/tree-list/*` sub-routes, and
// web.go:1695's `/branches/list` aux literal; the JSON handlers run the
// resolveUiRequest prologue like every GET page). No earlier registration
// can absorb these: the "blob" and "tree-list" heads are literals no
// registered pattern carries (the wave-2 /tree pair matches only the "tree"
// head; the typed tail regex keeps the tree-list claim equal to the
// parser's), the branches "list" tail is a distinct literal beside wave-16's
// bare /branches + /branches/delete pair, and unclaimed shapes never reach
// the sub-app — the dispatcher consults handlesUiRoute first.
uiRouter.get("/:owner/:repo/blob/*", (c) => uiPage(c));
uiRouter.get("/:owner/:repo/blob", (c) => uiPage(c));
uiRouter.get("/:owner/:repo/tree-list/:tlref{branch|tag|commit}/*", (c) => treeListAuxJson(c));
// Wave-43 tree-view envelope (parseUiRoute claims exactly this shape —
// upstream web.go:1302-1306's three typed sub-routes, the tree-list twin's
// wildcard form; the JSON handler runs the resolveUiRequest prologue like
// every GET page). No earlier registration can absorb these: the "tree-view"
// head is a literal no registered pattern carries (the wave-2 /tree pair
// matches only the "tree" head; the typed tail regex keeps the claim equal
// to the parser's), and unclaimed shapes never reach the sub-app — the
// dispatcher consults handlesUiRoute first.
uiRouter.get("/:owner/:repo/tree-view/:tvref{branch|tag|commit}/*", (c) => treeViewAuxJson(c));
uiRouter.get("/:owner/:repo/branches/list", (c) => branchesListAuxJson(c));
// Wave-40 owner projects board + write group (parseUiRoute claims exactly
// these shapes — upstream web.go:1140-1155's board view/write group plus
// web.go:327-345's board/workflow helper POSTs; the POST-only tails answer
// GET with chi's 405 — the hook test/delete convention; the POSTs run the
// §2.8 sameOriginGuard first). No earlier registration can absorb these:
// the static "-" segment outranks every dynamic peer and no registered
// pattern above carries a ≥5-segment /:owner/-/projects/* shape; within the
// namespace the "new"
// literal outranks the dynamic {id} pattern by REGISTRATION ORDER too (the
// matcher's first-match answer decides the 5-segment collision — verified
// by the /new renders; chi gives static segments precedence).
uiRouter.get("/:owner/-/projects/new", (c) => ownerProjectNewPage(c));
uiRouter.post("/:owner/-/projects/new", (c) => ownerProjectNewSubmit(c));
uiRouter.get("/:owner/-/projects/:id", (c) => ownerProjectBoardPage(c));
uiRouter.get("/:owner/-/projects/:id/edit", (c) => ownerProjectEditPage(c));
uiRouter.post("/:owner/-/projects/:id/edit", (c) => ownerProjectEditSubmit(c));
uiRouter.post("/:owner/-/projects/:id/delete", (c) => ownerProjectDeleteSubmit(c));
uiRouter.get("/:owner/-/projects/:id/delete", () => methodNotAllowed("POST"));
uiRouter.post("/:owner/-/projects/:id/open", (c) => ownerProjectStatusSubmit(c));
uiRouter.get("/:owner/-/projects/:id/open", () => methodNotAllowed("POST"));
uiRouter.post("/:owner/-/projects/:id/close", (c) => ownerProjectStatusSubmit(c));
uiRouter.get("/:owner/-/projects/:id/close", () => methodNotAllowed("POST"));
uiRouter.post("/:owner/-/projects/:id/columns/new", (c) => ownerProjectColumnNewSubmit(c));
uiRouter.get("/:owner/-/projects/:id/columns/new", () => methodNotAllowed("POST"));
uiRouter.post("/:owner/-/projects/:id/:columnId{\\d+}/default", (c) => ownerProjectColumnDefaultSubmit(c));
uiRouter.get("/:owner/-/projects/:id/:columnId{\\d+}/default", () => methodNotAllowed("POST"));
uiRouter.get("/:owner/-/projects/:id/workflows", (c) => ownerProjectWorkflowsPage(c));
uiRouter.post("/:owner/-/projects/:id/workflows", (c) => ownerProjectWorkflowCreateSubmit(c));
uiRouter.get("/:owner/-/projects/:id/workflows/:wid", (c) => ownerProjectWorkflowsPage(c));
uiRouter.post("/:owner/-/projects/:id/workflows/:wid", (c) => ownerProjectWorkflowUpdateSubmit(c));
uiRouter.post("/:owner/-/projects/:id/workflows/:wid/delete", (c) => ownerProjectWorkflowDeleteSubmit(c));
uiRouter.get("/:owner/-/projects/:id/workflows/:wid/delete", () => methodNotAllowed("POST"));
// Wave-41 releases download tail + rendered blob views (parseUiRoute claims
// exactly these shapes — upstream web.go:1513's `/releases/attachments/{uuid}`
// + web.go:1514's `/releases/download/{vTag}/{fileName}` (both chi
// single-segment params, so the claims are the exact 3-/4-segment shapes) and
// web.go:1715-1719's `/render` group (the three typed sub-routes are the /src
// family's wildcard shape, the `/blob/{sha}` arm the exact 2-segment one);
// the JSON/binary handlers run the resolveUiRequest prologue like every GET
// page). No earlier registration can absorb these: the "download" and
// "attachments" literals under /releases match shapes the wave-20 lines do
// not carry (`/releases/tag/*` matches only the "tag" head), the "render"
// head is a literal no registered pattern carries, and unclaimed shapes
// never reach the sub-app — the dispatcher consults handlesUiRoute first.
uiRouter.get("/:owner/:repo/releases/attachments/:uuid", (c) => releaseDownloadTail(c));
uiRouter.get("/:owner/:repo/releases/download/:vtag/:filename", (c) => releaseDownloadTail(c));
uiRouter.get("/:owner/:repo/render/branch/*", (c) => renderFileView(c));
uiRouter.get("/:owner/:repo/render/tag/*", (c) => renderFileView(c));
uiRouter.get("/:owner/:repo/render/commit/*", (c) => renderFileView(c));
uiRouter.get("/:owner/:repo/render/blob/:sha", (c) => renderFileView(c));
// The RAW + MEDIA byte families (parseUiRoute claims exactly these shapes —
// upstream web.go:1699-1713's two groups: the three typed wildcards, the
// 2-segment blob arm, and the deprecated catch-all wildcard; the bare
// `/raw`/`/media` literal is claimed by NOTHING — chi's `/*` does not match
// the empty tail — so it stays engine-owned). The "raw"/"media" heads are
// literals no registered pattern carries, and unclaimed shapes never reach
// the sub-app — the dispatcher consults handlesUiRoute first.
uiRouter.get("/:owner/:repo/raw/blob/:sha", (c) => rawMediaFile(c));
uiRouter.get("/:owner/:repo/raw/branch/*", (c) => rawMediaFile(c));
uiRouter.get("/:owner/:repo/raw/tag/*", (c) => rawMediaFile(c));
uiRouter.get("/:owner/:repo/raw/commit/*", (c) => rawMediaFile(c));
uiRouter.get("/:owner/:repo/raw/*", (c) => rawMediaFile(c));
uiRouter.get("/:owner/:repo/media/blob/:sha", (c) => rawMediaFile(c));
uiRouter.get("/:owner/:repo/media/branch/*", (c) => rawMediaFile(c));
uiRouter.get("/:owner/:repo/media/tag/*", (c) => rawMediaFile(c));
uiRouter.get("/:owner/:repo/media/commit/*", (c) => rawMediaFile(c));
uiRouter.get("/:owner/:repo/media/*", (c) => rawMediaFile(c));
// Wave-46 fragment mounts (parseUiRoute claims exactly these shapes — the
// machinery waves' routes: upstream web.go:1735's `/blob_excerpt/{sha}` repo
// twin + web.go:1618's wiki twin over repo.ExcerptBlob, and web.go:1761's
// `/lastcommit/*` wildcard (the bare URL included — chi's empty-tail match,
// the archive family's precedent; the default-branch arm 404-shells at the
// handler, the landed commit-arm convention). The HTML-fragment handlers run
// the resolveUiRequest prologue like every GET page. No earlier registration
// can absorb these: the "blob_excerpt", "wiki" and "lastcommit" heads are
// literals no registered pattern carries, the exact-shape params keep the
// claims equal to the parser's, and unclaimed shapes never reach the sub-app
// — the dispatcher consults handlesUiRoute first. The {repo} params stay
// PLAIN (no `[^-].*` constraint): the ae32b1a convention binds only when a
// static-second-segment `/-` twin exists (the projects families' case), and
// upstream's `/{username}/-` group (web.go:1107-1180) carries packages/
// mentions-in-owner/repositories/heatmap/projects ONLY — no blob_excerpt,
// no lastcommit, no wiki tail, so a leading-dash segment has no twin to
// shadow and the constraint would claim nothing (the /commits,/tags posture).
uiRouter.get("/:owner/:repo/blob_excerpt/:sha", (c) => blobExcerptFragment(c));
uiRouter.get("/:owner/:repo/wiki/blob_excerpt/:sha", (c) => blobExcerptFragment(c));
// The wiki raw byte arm (pages/wiki-raw.ts — web.go:1621) — AFTER the
// excerpt twin, BEFORE the wiki wildcard pair below (specific-before-
// wildcard; hono answers the first match, or the family is dead — the
// a58cad5 dead-wiki class). Plain {repo} param (no `[^-].*` constraint —
// the :10068-10074 rule). The BARE `/wiki/raw` literal rides BESIDE the
// wildcard: hono's `*` matches the empty tail (chi's does NOT — the
// wildcard-miss), so without the literal the bare tail would land in the
// byte handler's drift guard and 404 instead of the page family's
// reserved-name 303 `?action=_pages` miss (upstream parity).
uiRouter.get("/:owner/:repo/wiki/raw", (c) => wikiPage(c));
uiRouter.get("/:owner/:repo/wiki/raw/*", (c) => wikiRawBlob(c));
// Window-2e C2a wiki family — AFTER the excerpt twin (specific-before-
// wildcard; hono answers the first match).
uiRouter.get("/:owner/:repo/wiki", (c) => wikiPage(c));
uiRouter.get("/:owner/:repo/wiki/*", (c) => wikiPage(c));
uiRouter.post("/:owner/:repo/wiki", (c) => wikiSubmit(c));
uiRouter.post("/:owner/:repo/wiki/*", (c) => wikiSubmit(c));
uiRouter.get("/:owner/:repo/lastcommit/*", (c) => lastCommitFragment(c));
// The SPEC-0016 M2 packages subtree + repo tab (parseUiRoute claims exactly
// these shapes — upstream web.go:1109-1121's `/{username}/-` packages
// group and web.go:1546's repo `/packages` literal; GET only, the byte
// download rides the same shapes). No earlier registration can absorb
// these: the static "-" segment namespace carries no earlier
// /:owner/-/packages* shape, and within it the `/versions` literal is
// registered ahead of the dynamic `:version` pattern (chi's
// static-before-dynamic order, the projects `/new` precedent — hono
// answers the first match). The repo tab's `packages` literal head matches
// shapes no earlier registered pattern carries; its {repo} param carries
// the `[^-].*` constraint because the static-second-segment `/-` twin NOW
// EXISTS (the ae32b1a convention — the wave-45 projects case verbatim:
// hono's static second segments do NOT outrank params, so the plain
// pattern could shadow /:owner/-/packages).
uiRouter.get("/:owner/-/packages", (c) => ownerPackagesPage(c));
uiRouter.get("/:owner/-/packages/:type/:name", (c) => ownerPackageLatestRedirect(c));
uiRouter.get("/:owner/-/packages/:type/:name/versions", (c) => ownerPackageVersionsPage(c));
uiRouter.get("/:owner/-/packages/:type/:name/:version", (c) => ownerPackageVersionViewPage(c));
uiRouter.get("/:owner/-/packages/:type/:name/:version/files/:fileid{[0-9]+}", (c) => ownerPackageFileDownload(c));
uiRouter.get("/:owner/:repo{[^-].*}/packages", (c) => repoPackagesPage(c));
