// The planted negative for ASI-ONE-WRITER: Agora accepting a typed write.
// Destructured export, so the validator must resolve binding patterns too.
const handlers = {
  GET: () => Response.json([]),
  POST: () => Response.json({}, { status: 201 }),
  DELETE: () => new Response(null, { status: 204 }),
};

export const { GET, POST, DELETE } = handlers;
