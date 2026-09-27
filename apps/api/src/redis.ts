import { createClient } from "redis";

const redis = createClient({
    url: "redis://127.0.0.1:6379"
});

redis.on("error", (error) => {
    console.error("Redis error:", error);
});

export async function connectRedis() {
    if (!redis.isOpen) {
        await redis.connect();
        console.log("Redis connected");
    }
}

export default redis;