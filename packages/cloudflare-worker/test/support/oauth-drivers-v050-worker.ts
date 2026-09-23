/**
 * Entry worker for the concrete OAuth driver test project.
 *
 * The pool requires a `main` script to build the runner environment; the tests
 * import the driver modules directly and are never served by this worker.
 */
export default {
  async fetch(): Promise<Response> {
    return new Response("syndroo oauth driver fixture", { status: 200 });
  },
};
