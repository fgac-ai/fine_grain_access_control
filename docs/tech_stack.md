# Technical Architecture Strategy

This document outlines the core technical stack for the Fine-Grained Access Control Proxy platform.

## Infrastructure
**Vercel & Neon Postgres**
We will build this platform as a high-performance, edge-deployable application.
*   **Vercel**: Provides serverless edge functions for our API routes. Because our proxy sits in the critical path of every API call an agent makes, latency is paramount. Edge functions allow us to process validation rules instantly, close to the agent's deployment region.
*   **Neon Postgres**: A scalable, serverless Postgres database. It pairs perfectly with Vercel's edge architecture natively via HTTP connection pooling, preventing connection exhaustion when handling spikes of agent traffic.

## Authentication & Credential Management
**Clerk**
After re-evaluating the specific requirements of our API proxy—specifically the need to securely store and retrieve Google OAuth Refresh Tokens for long-running, offline background agents—we are pivoting to Clerk as our primary Identity Provider.

### The Google OAuth Overhead
The core architectural challenge of this platform is the **secure ingestion, storage, and lifecycle management of third-party Google OAuth credentials.**

*   **The Token Storage Vault:** When a user connects their Google account, we must store the Refresh Token so our proxy can fetch fresh Access Tokens days or weeks later when an agent makes a request. 
    *   **Clerk** natively stores the external OAuth Provider tokens within its own secure infrastructure. We can query Clerk on the backend (`clerkClient.users.getUserOauthAccessToken(userId, 'oauth_google')`) at any time, and Clerk handles the storage securely.
*   **The Refresh Lifecycle:**
    *   **Clerk** handles refresh token expiration automatically under the hood when we query their SDK.
*   **Google App Security Review:** To take our application out of "Testing" mode and get it verified by Google (especially for restricted scopes like Gmail/Drive), we must undergo a stringent Cloud Application Security Assessment (CASA). 
    *   Using **Clerk**, we offload the liability of storing the raw Google Refresh Tokens entirely to their highly compliant, SOC2-audited infrastructure. Our database only stores the proxy rules. This drastically shrinks our audit surface area and makes passing Google Security Review significantly easier.

## Data Flow (The Token Vault Pattern)
1. **User Setup**: User authenticates with our application via **Clerk**. They grant our application access to their Google Account (`https://www.googleapis.com/auth/gmail.modify` and the per-file `https://www.googleapis.com/auth/drive.file`; the full `drive` scope only through the feature-flagged Drive tree opt-in). **Clerk** stores the Google Refresh Token natively.
2. **Credential Issuance**: We issue the user a "Fake" Google Service Account JSON file (or a Custom API Key from Clerk) linked to their internal `user_id`.
3. **Agent Request**: The user's AI Agent makes a request to `https://proxy.ourdomain.com`, using our fake credential.
4. **Proxy Intercept**: Our Vercel Edge function receives the request. It validates the fake credential via **Clerk**, mapping it back to the `user_id`.
5. **Rule Evaluation**: We query Neon Postgres for the fine-grained rules associated with this `user_id` (e.g., "Is DELETE allowed on this folder ID?").
6. **Token Retrieval**: If the request is valid, our Vercel Edge function calls the **Clerk backend SDK** (`getUserOauthAccessToken()`) to instantly retrieve the user's *real*, fresh Google Access Token.
7. **Forwarding**: We append the real Google Access token to the request and forward it to `https://www.googleapis.com`.
