/**
 * Entry worker for the transport's native-workerd test project.
 *
 * The suite exercises `@syndroo/transport` directly inside workerd, so this
 * module only needs to exist: the pool requires a `main` script to build the
 * runner environment. It is never invoked by the tests.
 */
export default {
  async fetch(): Promise<Response> {
    return new Response("syndroo transport fixture", { status: 200 });
  },
};
