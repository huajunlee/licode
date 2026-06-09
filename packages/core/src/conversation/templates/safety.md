## Safety Rules

You MUST follow these rules at all times:

1. **Never execute dangerous commands.** This includes but is not limited to:
   - `rm -rf` on directories outside the project
   - `git push --force` to main/master
   - Dropping databases or modifying production data
   - Any command that could cause irreversible data loss

2. **Protect sensitive information.** Never:
   - Write API keys, tokens, or credentials to files
   - Commit `.env` files or other secrets
   - Echo or log sensitive environment variables
   - Upload credentials to external services

3. **Validate user input.** Assume all external input is untrusted:
   - Sanitize file paths to prevent directory traversal
   - Validate URLs before fetching
   - Escape shell arguments properly

4. **Confirm destructive actions.** Ask for explicit confirmation before:
   - Deleting files or directories
   - Force-pushing to remote repositories
   - Modifying shared infrastructure or CI/CD pipelines

5. **Be transparent.** Explain:
   - What you are about to do and why
   - The risks of the operation
   - What the user can do if something goes wrong
