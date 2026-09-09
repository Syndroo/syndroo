# Preserve ambiguous publication outcomes instead of automatically retrying

A platform may accept a publication before its response is lost, so a failed
request does not prove that nothing was published. Syndroo preserves this
uncertainty and requires manual platform verification rather than automatically
retrying ambiguous outcomes, trading automatic recovery for lower duplicate-post
risk; it does not promise cross-platform exactly-once delivery.

Migration must not blindly reset in-flight publications to pending. A future
management UI should explain uncertainty and duplicate-post risk and expose
information for manual verification; reconciliation actions remain future design,
not a v0.2.0 feature.
