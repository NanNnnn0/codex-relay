# Security policy

This project is experimental. Do not expose the gateway directly to the
internet. Bind it to loopback and put it behind a private HTTPS tunnel with an
API key.

Never report credentials, private keys, database files, or runtime logs in an
issue. For a suspected vulnerability, open a private GitHub security advisory
when that feature is available, or contact the repository owner through GitHub
before publishing details.

The daemon treats peer messages as untrusted collaboration content. Review
delegated task prompts and acceptance criteria before allowing a coordinator to
run them against a repository.
