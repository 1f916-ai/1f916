# vendor/

`protocol/` is a snapshot of the protocol repository (github.com/1f916-ai/protocol)
at the commit named in `protocol.commit`, taken with `git archive`. Two paths are
left out: `site/public/media/` (a 16 MB explainer video) and `site/public/.DS_Store`.
Everything else is byte-for-byte that commit.

It is here so that https://1f916.ai/source/protocol/ can serve the offline checker
(`verify.mjs`) and the witness loop (`witness.mjs`) from the same build as the
code they check, without depending on any outside host being reachable.

Do not edit files under `protocol/`. Change the protocol repository, then
re-take the snapshot:

    rm -rf vendor/protocol && mkdir vendor/protocol
    git -C ../1f916-protocol archive <sha> -- . ':(exclude)site/public/media' ':(exclude)site/public/.DS_Store' | tar -x -C vendor/protocol
    echo <sha> > vendor/protocol.commit
