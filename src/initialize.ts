import dotenv from "dotenv";

dotenv.config();

const threadpoolSize = process.env.BOT_UV_THREADPOOL_SIZE;
if (threadpoolSize && threadpoolSize !== "") {
  process.env.UV_THREADPOOL_SIZE = threadpoolSize;
}
