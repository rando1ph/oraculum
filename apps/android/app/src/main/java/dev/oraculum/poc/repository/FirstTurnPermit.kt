package dev.oraculum.poc.repository

/** A one-use compatibility fact from an explicit accepted thread/start, never cached or restored. */
class FirstTurnPermit {
    private data class Proof(val project: String, val thread: String, val epoch: String, val generation: Int, val idleVerified: Boolean = false)
    private var proof: Proof? = null

    fun acceptedStart(project: String, thread: String, epoch: String, generation: Int) {
        proof = Proof(project, thread, epoch, generation)
    }

    fun isCandidate(project: String, thread: String, epoch: String, generation: Int): Boolean =
        proof?.let { it.project == project && it.thread == thread && it.epoch == epoch && it.generation == generation } == true

    fun confirmNativeIdle(project: String, thread: String, epoch: String, generation: Int, status: String): Boolean {
        if (!isCandidate(project, thread, epoch, generation)) return false
        if (status != "idle") { invalidate(thread); return false }
        proof = proof?.copy(idleVerified = true)
        return true
    }

    fun allows(project: String, thread: String, epoch: String, generation: Int, online: Boolean, unknown: Boolean): Boolean =
        online && !unknown && isCandidate(project, thread, epoch, generation) && proof?.idleVerified == true

    /** Call at the dispatch cut point after durable intent; even a lost ACK consumes it. */
    fun consume(project: String, thread: String, epoch: String, generation: Int): Boolean {
        val allowed = allows(project, thread, epoch, generation, online = true, unknown = false)
        invalidate(thread)
        return allowed
    }

    fun invalidate(thread: String? = null) {
        if (thread == null || proof?.thread == thread) proof = null
    }
}
