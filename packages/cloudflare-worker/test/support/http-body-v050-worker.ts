/**
 * Entry worker for the inbound HTTP body test project.
 *
 * The pool requires a `main` script to build the runner environment; the tests
 * import the reader directly and are never served by this worker.
 */
export default {
  async fetch(): Promise<Response> {
    return new Response("syndroo http body fixture", { status: 200 });
  },
};
