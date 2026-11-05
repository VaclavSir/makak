# Env files

The Panel creates sandboxes from [sbx env files](https://docs.docker.com/ai/sandboxes/configuration/environment-files/): YAML files that declare the agent, the workspace, ports, kits, secrets and host commands of a sandbox. You keep a set of them in the **env directory**, and combine the ones a task needs when you create a sandbox.

Start from the examples in [`examples/envs/`](../examples/envs/):

```sh
mkdir -p ~/makak/envs
cp examples/envs/*.sbxenv.yaml ~/makak/envs/
```

The directory is `~/makak/envs` unless `envDir` says otherwise; see [configuration](configuration.md).

## How the Panel uses them

1. **Discovery.** Every `*.sbxenv.yaml` file in the env directory is offered, sorted by name. Files whose names start with `00-` start out checked. Subdirectories and other files are ignored.
2. **The form.** The Panel merges the checked files and generates a field for each arg they declare under `args:`. `description` becomes the field's help text, `enum` a dropdown, `pattern` a validation rule, and `required` makes the field mandatory. A field left empty falls back to the file's `default`.
3. **The name.** You name the sandbox, and the Panel passes it as `--name`. If the files declare an arg called `sandbox`, the Panel fills it with the same name and doesn't ask for it. There is no built-in reference to the sandbox name, so this is how a file uses it, e.g. in an environment variable.
4. **The plan.** _Show the plan_ runs `sbx env plan` and shows what it prints, with the [workflow warnings](#workflow-warnings). Nothing is applied yet.
5. **Applying.** _Approve and create_ runs `sbx env run --detach --force` with the same files and args. `--force` approves the plan for that one invocation. The Panel first checks that no file changed since the plan was shown, and asks you to review the new plan if one did.
6. **The record.** The Panel records the files, in order, and the args, and replays them for every later `sbx env` command. `sbx env` needs the same files, args and name to find the same sandbox again. Fields start out filled with their defaults, and those values are recorded like any other, so changing a default in a file later doesn't change existing sandboxes or recreate them differently. Clear a field to leave it to the file's default instead.

Starting a stopped sandbox shows the plan again, because `initialize` host commands run on every `sbx env run`. Removing it runs `sbx env rm --force` with the recorded files, after a confirmation that lists what would be lost and the `preRemove` commands that run first.

A sandbox the Panel didn't create is **unmanaged**: the Panel can start, stop and remove it, with `sbx run --detach`, `sbx stop` and `sbx rm`, but doesn't know how it was configured.

_New from this_ on a managed sandbox, and _Create again_ on a removed one, open the create form with the same files and args.

## Writing env files

The Panel passes every file explicitly, so `sbx` merges them in name order and skips `~/.sbxenv.yaml`. A few rules follow from that.

- **Put the base first.** Name the file every sandbox needs `00-base.sbxenv.yaml`, and give it `schemaVersion: "1"` and `agent`. Number the others to fix their order: later files override earlier ones.
- **Use absolute or arg-driven paths, never relative ones.** Some relative paths resolve from the first file's directory, others from the declaring file's, and the env directory is not where your projects are. Declare an arg for anything that varies, such as the project path, and use `${{ env.fileDir }}` for files that live beside the env file.
- **Declare each arg in one file.** Merging concatenates lists, so an arg declared in two files gets both files' `enum` values.
- **Leave `name:` out.** The Panel always passes `--name`.
- **Make `initialize` commands safe to repeat.** They run on every create and start.
- **Keep the env directory out of every workspace.** Env files run host commands; an agent that can edit them can run commands on your machine.

How files merge: maps merge by key, lists concatenate, and any other value from a later file replaces the earlier one. Arg references (`${{ env.args.NAME }}`) work anywhere a YAML value can appear, except inside `args:`.

The Panel checks `enum` and `pattern` before planning. `pattern` is an RE2 expression that must match the whole value; the Panel checks it as a JavaScript regular expression, which agrees with RE2 on ordinary patterns, and leaves the rest to `sbx`.

## The examples

| File | What it adds | Args |
| --- | --- | --- |
| `00-base.sbxenv.yaml` | The agent, and the project as a private clone | `sandbox`, `agent`, `project` |
| `10-reference.sbxenv.yaml` | Another project, read-only | `reference` |
| `20-web.sbxenv.yaml` | The dev server and livereload ports, for the [reverse proxy](configuration.md#listener-ports) | `dev_port` |
| `30-resources.sbxenv.yaml` | CPU and memory limits | `cpus`, `memory` |

## Workflow warnings

The [Makak Workflow](workflow.md) relies on settings in the env files. The Panel warns, on the plan and on the sandbox's page, when the merged files depart from it:

- **The workspace is not a clone.** The agent edits your repository directly. Use `workspace: { path: …, clone: true }`.
- **An additional workspace is writable.** Additional workspaces are mounted directly even in clone mode, so the agent could change another project on the host. Set `readOnly: true`.
- **The env files are writable from the sandbox** (`sandboxOptions.writableEnvFiles`).

Warnings never block anything. `sbx env plan` is the authority on what a sandbox gets; the Panel reads the files only as far as these warnings need.

Two parts of the workflow live outside env files, and the Panel doesn't check them yet:

- **The forge is denied.** That is network policy, set with `sbx policy deny network` (see `sbx policy --help`), not in env files.
- **MCP servers are static.** `--static-mcp` exists only on `sbx create` and `sbx run`; env files can't set it. Without it, the sbx gateway offers the agent `mcp-find` and `mcp-add`, so it can add servers that bypass the Panel.
- **The Panel's MCP servers.** Env files can name an MCP server only with a `url` or `command`, and can't give it headers, so they can't name the Panel's registrations. The Panel loads those itself.
