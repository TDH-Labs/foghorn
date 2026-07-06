# Privacy Policy — Foghorn (Personal LinkedIn Integration)

*Last updated: 2026-07-06*

## What this is

Foghorn is a personal, single-user automation tool built and operated by one
individual for their own use. It is not a commercial product, is not offered
to the public, and has no users besides its developer/operator. This policy
describes how Foghorn's LinkedIn integration handles data.

## What this application accesses via LinkedIn

When authorized via LinkedIn OAuth (scopes: `openid`, `profile`,
`w_member_social`), this application can:

- Read the authorized member's own basic profile information (name, LinkedIn
  member ID) to identify the account posting on their behalf.
- Publish text posts to the authorized member's own LinkedIn feed, only after
  the member has personally reviewed and approved that specific post through
  a private approval interface (Telegram).

This application does **not** request access to any other LinkedIn member's
data, does not read connections, messages, or feed content belonging to
anyone but its own operator, and is not used on behalf of any member other
than its single operator.

## Other data this application uses (not from LinkedIn)

To draft posts that sound like its operator, this application separately
processes, entirely outside of LinkedIn:

- The operator's own past social media posts and personal chat history (from
  messaging apps the operator personally uses), to learn writing style and
  topics of interest.
- Where group conversations are involved, messages from other participants
  are read only to build a one-way safeguard that blocks this application
  from ever quoting someone else's private words in a public post. Other
  participants' message text is never used to generate content, never
  included in any prompt sent to an AI model, and is not retained in any form
  that could reproduce their original text.

## Where data is stored

All data is stored locally on the operator's own computer, in a local
database. Nothing is stored on shared or third-party servers beyond what is
described below, sold, shared with advertisers, or used for any purpose
other than operating this personal tool.

## Third parties this application sends data to

- **AI model providers** (Anthropic and/or OpenRouter) — to draft and review
  post text before it is ever shown to the operator for approval.
- **LinkedIn, X, and Nostr** — to publish content, via each platform's own
  official API, only after the operator has approved that specific post.
- **Telegram** — to deliver approval requests to the operator's own device.
  No post is published without this approval step, except for a narrow,
  explicitly pre-configured set of low-risk content types the operator has
  separately opted into after a sustained period of manual approval.

## Revoking access

The authorized member can revoke this application's access at any time from
their own LinkedIn account settings (**Settings & Privacy → Data privacy →
Other applications**). Revocation immediately stops all API access.

## Scope of this policy

This document describes a personal, single-operator tool with no other end
users. It is not intended to describe, and should not be relied upon for,
any multi-user or commercial product.
