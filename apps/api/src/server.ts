import { Temporal } from "@js-temporal/polyfill";
import { calculateDistance } from "./distance.js";
import redis, { connectRedis } from "./redis.js";
(globalThis as any).Temporal = Temporal;
import { db } from "./prisma/db.js";
// console.log(
//     Object.getOwnPropertyNames(
//         Object.getPrototypeOf(db.orm.public.Driver)
//     )
// );
// console.log(
//     Object.getOwnPropertyNames(
//         Object.getPrototypeOf(db.orm.public.Driver.update)
//     )
// );
import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();
// const testDriver = db.orm.public.Driver
//     .where({ id: 1 });

// console.log(testDriver);
// const testDriver = db.orm.public.Driver.where({ id: 1 });

// console.log(
//     Object.getOwnPropertyNames(
//         Object.getPrototypeOf(testDriver)
//     )
// );
const app = express();

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
    res.json({
        message: "Ride Matching Platform API is running"
    });
});
app.get("/users", async (req, res) => {
    try {
        const users = await db.orm.public.User.all();

        res.json(users);
    } catch (error) {
        console.error(error);
        res.status(500).json({
            message: "Database query failed"
        });
    }
});
app.get("/rides/:id/match", async (req, res) => {
    const rideId = Number(req.params.id);

    try {
        const ride = await db.orm.public.Ride
            .where({ id: rideId })
            .first();

        if (!ride) {
            return res.status(404).json({
                message: "Ride not found"
            });
        }

        // Get available drivers from PostgreSQL
        const drivers = await db.orm.public.Driver
            .where({ status: "AVAILABLE" })
            .all();

        if (drivers.length === 0) {
            return res.status(404).json({
                message: "No available drivers"
            });
        }

        // Get live locations from Redis
        const driversWithLocation = [];

        for (const driver of drivers) {
            const location = await redis.hGetAll(
                `driver:${driver.id}:location`
            );

            if (
                location.latitude &&
                location.longitude
            ) {
                driversWithLocation.push({
                    driver,
                    latitude: Number(location.latitude),
                    longitude: Number(location.longitude)
                });
            }
        }

        if (driversWithLocation.length === 0) {
            return res.status(404).json({
                message: "No available drivers with location"
            });
        }

        // Find nearest driver
        const nearestDriver = driversWithLocation.reduce(
            (nearest, current) => {
                const distance = calculateDistance(
                    ride.pickupLat,
                    ride.pickupLng,
                    current.latitude,
                    current.longitude
                );

                if (
                    nearest === null ||
                    distance < nearest.distance
                ) {
                    return {
                        driver: current.driver,
                        distance
                    };
                }

                return nearest;
            },
            null as {
                driver: typeof driversWithLocation[number]["driver"];
                distance: number;
            } | null
        );

        // Assign driver to ride
        await db.orm.public.Ride
            .where({ id: rideId })
            .updateAll({
                driverId: nearestDriver!.driver.id
            });

        res.json({
            rideId: ride.id,
            driverId: nearestDriver!.driver.id,
            distanceKm: nearestDriver!.distance
        });

    } catch (error) {
        console.error("RIDE MATCHING ERROR:", error);

        res.status(500).json({
            message: "Failed to match driver"
        });
    }
});
app.patch("/rides/:id/accept", async (req, res) => {
    const rideId = Number(req.params.id);

    try {
        const ride = await db.orm.public.Ride
            .where({ id: rideId })
            .all();

        if (ride.length === 0) {
            return res.status(404).json({
                message: "Ride not found"
            });
        }

        if (ride[0].status !== "REQUESTED") {
            return res.status(400).json({
                message: "Ride cannot be accepted"
            });
        }

        const matched = await db.orm.public.Ride
            .where({ id: rideId })
            .all();

        if (!matched[0].driverId) {
            return res.status(400).json({
                message: "No driver assigned"
            });
        }

        const result = await db.orm.public.Ride
            .where({ id: rideId })
            .updateAll({
                status: "ACCEPTED"
            });

        await db.orm.public.Driver
            .where({ id: matched[0].driverId })
            .updateAll({
                status: "ON_TRIP"
            });

        res.json(result);

    } catch (error) {
        console.error("ACCEPT RIDE ERROR:", error);

        res.status(500).json({
            message: "Failed to accept ride"
        });
    }
});
app.patch("/rides/:id/start", async (req, res) => {
    const rideId = Number(req.params.id);

    try {
        const ride = await db.orm.public.Ride
            .where({ id: rideId })
            .first();

        if (!ride) {
            return res.status(404).json({
                message: "Ride not found"
            });
        }

        if (ride.status !== "ACCEPTED") {
            return res.status(400).json({
                message: "Ride cannot be started"
            });
        }

        const result = await db.orm.public.Ride
            .where({ id: rideId })
            .updateAll({
                status: "IN_PROGRESS"
            });

        res.json(result);

    } catch (error) {
        console.error("START RIDE ERROR:", error);

        res.status(500).json({
            message: "Failed to start ride"
        });
    }
});
app.patch("/rides/:id/complete", async (req, res) => {
    const rideId = Number(req.params.id);

    try {
        const ride = await db.orm.public.Ride
            .where({ id: rideId })
            .first();

        if (!ride) {
            return res.status(404).json({
                message: "Ride not found"
            });
        }

        if (ride.status !== "IN_PROGRESS") {
            return res.status(400).json({
                message: "Ride cannot be completed"
            });
        }

        if (!ride.driverId) {
            return res.status(400).json({
                message: "No driver assigned"
            });
        }

        await db.orm.public.Ride
            .where({ id: rideId })
            .updateAll({
                status: "COMPLETED"
            });

        await db.orm.public.Driver
            .where({ id: ride.driverId })
            .updateAll({
                status: "AVAILABLE"
            });

        const updatedRide = await db.orm.public.Ride
            .where({ id: rideId })
            .first();

        res.json(updatedRide);

    } catch (error) {
        console.error("COMPLETE RIDE ERROR:", error);

        res.status(500).json({
            message: "Failed to complete ride"
        });
    }
});
app.get("/drivers", async (req, res) => {
    try {
        const drivers = await db.orm.public.Driver.all();

        res.json(drivers);
    } catch (error) {
        console.error(error);
        res.status(500).json({
            message: "Database query failed"
        });
    }
});
app.post("/users", async (req, res) => {
    console.log("POST /users RECEIVED");
    console.log("BODY:", req.body);

    try {
        const { name, email, passwordHash, role } = req.body;

        console.log("Creating user...");

        const user = await db.orm.public.User.create({
                name,
                email,
                passwordHash,
                role 
        });

        console.log("USER CREATED:", user);

        res.status(201).json(user);
    } catch (error) {
        console.error("DATABASE ERROR:", error);

        res.status(500).json({
            message: "Failed to create user"
        });
    }
});
app.post("/drivers", async (req, res) => {
    console.log("POST /drivers RECEIVED");
    console.log("BODY:", req.body);

    try {
        const { userId, vehicleType } = req.body;

        console.log("Creating driver...");

        const driver = await db.orm.public.Driver.create({
            userId,
            vehicleType,
            status: "OFFLINE"
        });

        console.log("DRIVER CREATED:", driver);

        res.status(201).json(driver);
    } catch (error) {
        console.error("DRIVER DATABASE ERROR:", error);

        res.status(500).json({
            message: "Failed to create driver"
        });
    }
});
app.get("/drivers", async (req, res) => {
    console.log("GET /drivers RECEIVED");

    try {
        const drivers = await db.orm.public.Driver.all();

        console.log("DRIVERS:", drivers);

        res.json(drivers);
    } catch (error) {
        console.error("DRIVER DATABASE ERROR:", error);

        res.status(500).json({
            message: "Database query failed"
        });
    }
});
app.get("/drivers/:id", async (req, res) => {
    const driverId = Number(req.params.id);

    try {
        const driver = await db.orm.public.Driver
            .where({ id: driverId })
            .first();

        if (!driver) {
            return res.status(404).json({
                message: "Driver not found"
            });
        }

        res.json(driver);
    } catch (error) {
        console.error("GET DRIVER ERROR:", error);

        res.status(500).json({
            message: "Failed to fetch driver"
        });
    }
});
app.patch("/drivers/:id/status", async (req, res) => {
    const driverId = Number(req.params.id);
    const { status } = req.body;

    if (!["OFFLINE", "AVAILABLE", "ON_TRIP"].includes(status)) {
        return res.status(400).json({
            message: "Invalid driver status"
        });
    }

    try {
        const result = await db.orm.public.Driver
            .where({ id: driverId })
            .updateAll({
                status
            });

        res.json(result);
    } catch (error) {
        console.error("DRIVER STATUS ERROR:", error);

        res.status(500).json({
            message: "Failed to update driver status"
        });
    }
});
app.post("/rides", async (req, res) => {
    console.log("POST /rides RECEIVED");
    console.log("BODY:", req.body);

    try {
        const {
            riderId,
            pickupLat,
            pickupLng,
            destinationLat,
            destinationLng
        } = req.body;

        console.log("Creating ride...");

        const ride = await db.orm.public.Ride.create({
            riderId,
            pickupLat,
            pickupLng,
            destinationLat,
            destinationLng,
            status: "REQUESTED"
        });

        console.log("RIDE CREATED:", ride);

        res.status(201).json(ride);
    } catch (error) {
        console.error("RIDE DATABASE ERROR:", error);

        res.status(500).json({
            message: "Failed to create ride"
        });
    }
});
app.get("/rides", async (req, res) => {
    try {
        const rides = await db.orm.public.Ride.all();

        res.json(rides);
    } catch (error) {
        console.error("RIDE DATABASE ERROR:", error);

        res.status(500).json({
            message: "Database query failed"
        });
    }
});
app.get("/rides/:id", async (req, res) => {
    const rideId = Number(req.params.id);

    try {
        const ride = await db.orm.public.Ride
            .where({ id: rideId })
            .first();

        if (!ride) {
            return res.status(404).json({
                message: "Ride not found"
            });
        }

        res.json(ride);
    } catch (error) {
        console.error("RIDE DATABASE ERROR:", error);

        res.status(500).json({
            message: "Database query failed"
        });
    }
});
app.patch("/rides/:id/cancel", async (req, res) => {
    const rideId = Number(req.params.id);

    try {
        const ride = await db.orm.public.Ride
            .where({ id: rideId })
            .first();

        if (!ride) {
            return res.status(404).json({
                message: "Ride not found"
            });
        }

        if (ride.status === "COMPLETED") {
            return res.status(400).json({
                message: "Completed ride cannot be cancelled"
            });
        }

        const result = await db.orm.public.Ride
            .where({ id: rideId })
            .updateAll({
                status: "CANCELLED"
            });

        res.json(result);
    } catch (error) {
        console.error("RIDE CANCEL ERROR:", error);

        res.status(500).json({
            message: "Failed to cancel ride"
        });
    }
});
app.get("/drivers/available", async (req, res) => {
    try {
        const drivers = await db.orm.public.Driver
            .where({ status: "AVAILABLE" })
            .all();

        res.json(drivers);
    } catch (error) {
        console.error("AVAILABLE DRIVERS ERROR:", error);

        res.status(500).json({
            message: "Failed to fetch available drivers"
        });
    }
});
app.patch("/drivers/:id/location", async (req, res) => {
    const driverId = Number(req.params.id);
    const { latitude, longitude } = req.body;
    const driver = await db.orm.public.Driver
    .where({ id: driverId })
    .first();

if (!driver) {
    return res.status(404).json({
        message: "Driver not found"
    });
}

    if (
        typeof latitude !== "number" ||
        typeof longitude !== "number" ||
        latitude < -90 ||
        latitude > 90 ||
        longitude < -180 ||
        longitude > 180
    ) {
        return res.status(400).json({
            message: "Invalid latitude or longitude"
        });
    }

    try {
      await redis.hSet(`driver:${driverId}:location`, {
    latitude: String(latitude),
    longitude: String(longitude)
});

res.json({
    driverId,
    latitude,
    longitude
});
    } catch (error) {
        console.error("DRIVER LOCATION ERROR:", error);

        res.status(500).json({
            message: "Failed to update driver location"
        });
    }
});
const PORT = process.env.PORT || 5000;
await connectRedis();
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});