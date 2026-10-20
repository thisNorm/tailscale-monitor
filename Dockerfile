FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/data MONITOR_BIND=0.0.0.0 MONITOR_PORT=8787
RUN apk add --no-cache docker-cli docker-cli-compose && mkdir /data && chown node:node /data
COPY --chown=node:node package.json server.mjs monitor.mjs tailscale.mjs integrations.mjs demo.mjs updates.mjs updater.mjs ./
COPY --chown=node:node public ./public
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:8787/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "server.mjs"]
