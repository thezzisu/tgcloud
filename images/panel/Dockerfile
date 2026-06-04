# tgcloud-panel: WOC panel + PAT/agent overlay
# Multi-arch: linux/amd64, linux/arm64

# --- 1) Build frontend ---
FROM node:22-slim AS web
WORKDIR /web
COPY 3rd/WechatOnCloud/panel/web/package.json ./
RUN npm install
COPY 3rd/WechatOnCloud/panel/web/ ./
# Add TokensModal component
COPY images/panel/overlay/web/src/pages/Tokens.tsx ./src/pages/Tokens.tsx
# Patch Admin.tsx: import TokensModal + add state + button + modal render
RUN sed -i "1i import { TokensModal } from './Tokens';" src/pages/Admin.tsx && \
    sed -i '/const \[renameInst/a \ \ const [showTokens, setShowTokens] = useState(false);' src/pages/Admin.tsx && \
    sed -i 's|<button className="btn btn-primary inst-act-wide" onClick={onChangePassword}>|<button className="btn inst-act-wide" onClick={() => setShowTokens(true)}>API 令牌</button>\n              <button className="btn btn-primary inst-act-wide" onClick={onChangePassword}>|' src/pages/Admin.tsx && \
    sed -i '/{renameInst && /i \ \ \ \ \ \ {showTokens \&\& <TokensModal onClose={() => setShowTokens(false)} />}' src/pages/Admin.tsx
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
