# tgcloud-panel: WOC panel + PAT/agent overlay
# Multi-arch: linux/amd64, linux/arm64

# --- 1) Build frontend ---
FROM node:22-slim AS web
WORKDIR /web
COPY 3rd/WechatOnCloud/panel/web/package.json ./
RUN npm install
COPY 3rd/WechatOnCloud/panel/web/ ./
# Add Tokens page
COPY images/panel/overlay/web/src/pages/Tokens.tsx ./src/pages/Tokens.tsx
# Patch AppShell to add Tokens route + nav item
RUN sed -i \
  "s|import Admin from './pages/Admin';|import Admin from './pages/Admin';\nimport Tokens from './pages/Tokens';|" \
  src/AppShell.tsx && \
  sed -i \
  's|<Route path="/admin"|<Route path="/tokens" element={<Tokens />} />\n            <Route path="/admin"|' \
  src/AppShell.tsx && \
  sed -i \
  's|<button className={.sb-item. + (loc.pathname === ./admin.|<button className={"sb-item" + (loc.pathname === "/tokens" ? " on" : "")} onClick={() => go("/tokens")} title="API 令牌"><span className="sb-ic"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg></span>{!collapsed \&\& <span className="sb-label">API 令牌</span>}</button>\n        \0|' \
  src/AppShell.tsx
RUN npm run build

# --- 2) Backend runtime ---
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Install server dependencies
COPY 3rd/WechatOnCloud/panel/server/package.json ./
RUN npm install

# Copy WOC server source
COPY 3rd/WechatOnCloud/panel/server/ ./

# Overlay our additional modules
COPY images/panel/overlay/server/src/pat.ts ./src/pat.ts
COPY images/panel/overlay/server/src/tg-exec.ts ./src/tg-exec.ts
COPY images/panel/overlay/server/src/agent.ts ./src/agent.ts

# Patch store.ts: export listUsersRaw + persistStore for agent module
RUN sed -i 's|^function persist()|export function persistStore() { persist(); }\nfunction persist()|' src/store.ts && \
    sed -i '/^export function initStore/i export function listUsersRaw(): any[] { return data.users; }' src/store.ts

# Patch index.ts: import and register agent routes before await app.ready()
RUN sed -i "1i import { registerAgentRoutes } from './agent.js';" src/index.ts && \
    sed -i "2i import { listUsersRaw, persistStore } from './store.js';" src/index.ts && \
    sed -i '/^await app.ready/i registerAgentRoutes(app, listUsersRaw, persistStore);' src/index.ts

# Copy built frontend
COPY --from=web /web/dist ./web-dist

ENV STATIC_DIR=/app/web-dist \
    PORT=8080
EXPOSE 8080
CMD ["npm", "run", "start"]
