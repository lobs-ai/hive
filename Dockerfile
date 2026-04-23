FROM node:22-alpine

# Tools the bootstrap agent will need when running commands
RUN apk add --no-cache git bash curl

WORKDIR /app

# Ship only the compiled output of the agentic packages — no source.
# The agent should not be able to read the runtime's implementation.
COPY agentic/packages/llm/package.json     ./agentic/packages/llm/package.json
COPY agentic/packages/llm/dist             ./agentic/packages/llm/dist
COPY agentic/packages/tools/package.json   ./agentic/packages/tools/package.json
COPY agentic/packages/tools/dist           ./agentic/packages/tools/dist
COPY agentic/packages/runner/package.json  ./agentic/packages/runner/package.json
COPY agentic/packages/runner/dist          ./agentic/packages/runner/dist

# Copy hive
COPY hive/package.json hive/tsconfig.json hive/constitution.md ./hive/
COPY hive/scripts ./hive/scripts
COPY hive/src ./hive/src

WORKDIR /app/hive

RUN node scripts/setup.mjs

CMD ["npm", "start"]
