//--------------------------- Importing necessary libraries ---------------------------
require("dotenv").config();
const express = require('express');
const app = express();
const jwt = require("jsonwebtoken");
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const cors = require('cors');
const port = process.env.PORT || 3000; // Default to port 3000 if PORT is not set
const secretKey = process.env.JWT_SECRET || 'default_secret'; // Use environment variable for secret key
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
//--------------------------- EOF Importing necessary libraries ---------------------------

//--------------------------- Middleware setup ---------------------------
app.use(cors()); // Enable CORS for all routes
app.use(express.json()); // Body parser middleware,parse JSON request bodies
//--------------------------- EOF Middleware setup ---------------------------

//--------------------------- Function to create JWT token ---------------------------
function createToken(user) {
    const token = jwt.sign(
        { email: user.email },
        secretKey,
        { expiresIn: "7d" }
    );
    return token;
}
//--------------------------- EOF Function to create JWT token ---------------------------

//--------------------------- Middleware to verify JWT token ---------------------------
function verifyToken(req, res, next) {
    try {
        const token = req.headers.authorization.split(" ")[1];
        const verify = jwt.verify(token, secretKey);
        if (!verify?.email) {
            return res.status(401).send("You are not authorized");
        }
        req.user = verify.email;
        next();
    } catch (error) {
        return res.status(401).send("You are not authorized");
    }
}
//--------------------------- EOF Middleware to verify JWT token ---------------------------

//--------------------------- MongoDB connection URI ---------------------------
const uri = process.env.DATABASE_URL;
const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    }
});
//--------------------------- EOF MongoDB connection URI ---------------------------

//--------------------------- Async function to run server ---------------------------
async function run() {
    try {
        await client.connect();
        console.log("You successfully connected to MongoDB!");

        const userDB = client.db("userDB");
        const userCollection = userDB.collection("userCollection");

        const productDB = client.db("productDB");
        const productCollection = productDB.collection("products");

        //--------------------------- Routes for user operations ---------------------------

        // Endpoint to register or login user
        app.post("/user", async (req, res) => {
            const user = req.body;
            const token = createToken(user);

            const isUserExist = await userCollection.findOne({ email: user?.email });
            if (isUserExist) {
                return res.send({
                    status: "success",
                    message: "Login success",
                    token,
                });
            }
            await userCollection.insertOne(user);
            res.send({ status: "success", message: "Registration successful", token });
        });

        // Endpoint to fetch user details by ID
        app.get("/user/get/:id", async (req, res) => {
            const id = req.params.id;
            const result = await userCollection.findOne({ _id: new ObjectId(id) });
            res.send(result);
        });

        // Endpoint to fetch user details by email
        app.get("/user/:email", async (req, res) => {
            const email = req.params.email;
            const result = await userCollection.findOne({ email });
            res.send(result);
        });
        //--------------------------- EOF Routes for user operations ---------------------------

        //--------------------------- Routes for product operations ---------------------------

        // Add new product
        app.post('/products', async (req, res) => {
            const { name, description, price, imageURL, stock } = req.body;
            const newProduct = { name, description, price: parseFloat(price), imageURL, stock: parseInt(stock) };

            try {
                const result = await productCollection.insertOne(newProduct);
                const createdProduct = await productCollection.findOne({ _id: result.insertedId });
                res.status(201).json(createdProduct);
            } catch (err) {
                console.error('Error adding product:', err);
                res.status(400).json({ message: 'Failed to add product' });
            }
        });

        // Get all products
        app.get('/products', async (req, res) => {
            try {
                const products = await productCollection.find({}).toArray();
                res.json(products);
            } catch (err) {
                console.error('Error fetching products:', err);
                res.status(500).json({ message: 'Failed to fetch products' });
            }
        });

        // Get Product by ID
        app.get('/products/:id', async (req, res) => {
            try {
                const product = await productCollection.findOne({ _id: new ObjectId(req.params.id) });
                if (!product) {
                    return res.status(404).json({ message: 'Product not found' });
                }
                res.json(product);
            } catch (err) {
                console.error('Error fetching product:', err);
                res.status(500).json({ message: 'Failed to fetch product' });
            }
        });

        // Update product
        app.patch('/products/:id', verifyToken, async (req, res) => {
            const { name, description, price, imageURL, stock } = req.body;
            const updatedProduct = {
                name,
                description,
                price: parseFloat(price),
                imageURL,
                stock: parseInt(stock),
            };

            try {
                const result = await productCollection.updateOne(
                    { _id: new ObjectId(req.params.id) },
                    { $set: updatedProduct }
                );

                if (result.modifiedCount === 0) {
                    return res.status(404).json({ message: 'Product not found' });
                }

                res.json(updatedProduct);
            } catch (err) {
                console.error('Error updating product:', err);
                res.status(400).json({ message: 'Failed to update product' });
            }
        });

        // Delete product
        app.delete('/products/:id', verifyToken, async (req, res) => {
            try {
                const result = await productCollection.deleteOne({ _id: new ObjectId(req.params.id) });
                if (result.deletedCount === 0) {
                    return res.status(404).json({ message: 'Product not found' });
                }
                res.json({ message: 'Product deleted' });
            } catch (err) {
                console.error('Error deleting product:', err);
                res.status(500).json({ message: 'Failed to delete product' });
            }
        });

        // Endpoint to create a payment intent
        app.post('/products/:id/purchase', async (req, res) => {
            const { id: productId } = req.params;
            const { quantity } = req.body;

            try {
                const product = await productCollection.findOne({ _id: new ObjectId(productId) });
                if (!product) {
                    return res.status(404).json({ message: 'Product not found' });
                }

                if (product.stock < quantity) {
                    return res.status(400).json({ message: 'Not enough stock available' });
                }

                const amount = product.price * quantity * 100; // Stripe expects the amount in cents

                const paymentIntent = await stripe.paymentIntents.create({
                    amount,
                    currency: 'usd',
                    payment_method_types: ['card'],
                });

                res.json({ clientSecret: paymentIntent.client_secret });
            } catch (error) {
                console.error('Error creating payment intent:', error);
                res.status(500).json({ message: 'Failed to create payment intent' });
            }
        });

        // Endpoint to handle payment confirmation after client-side confirmation
        app.post('/products/:id/confirm-payment', async (req, res) => {
            const productId = req.params.id;
            const { paymentIntentId, quantity } = req.body;

            try {
                // Retrieve product details again to verify
                const product = await productCollection.findOne({ _id: new ObjectId(productId) });
                if (!product) {
                    return res.status(404).json({ message: 'Product not found' });
                }

                // Retrieve the PaymentIntent from Stripe using its ID
                const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);

                // Handle payment confirmation logic here, 
                // update product stock after successful payment
                if (paymentIntent.status === 'succeeded') {
                    const updatedStock = product.stock - quantity;
                    const status = updatedStock === 0 ? 'Out of Stock' : 'In Stock';

                    const result = await productCollection.updateOne(
                        { _id: new ObjectId(productId) },
                        { $set: { stock: updatedStock, status } }
                    );

                    if (result.modifiedCount === 0) {
                        return res.status(400).json({ message: 'Failed to update product stock' });
                    }

                    const updatedProduct = await productCollection.findOne({ _id: new ObjectId(productId) });

                    return res.json({ message: 'Payment succeeded', product: updatedProduct });
                } else {
                    return res.status(400).json({ message: 'Payment not successful' });
                }
            } catch (error) {
                console.error('Error confirming payment:', error.message);
                res.status(500).json({ error: 'Failed to confirm payment' });
            }
        });
        //--------------------------- EOF Routes for product operations ---------------------------

    } finally {
        // Do not close the client connection to handle multiple requests
    }
}
//--------------------------- EOF Async function to run server ---------------------------

//--------------------------- Call the run function ---------------------------
run().catch(console.dir);
//--------------------------- EOF Call the run function ---------------------------

//--------------------------- Route for root path ---------------------------
app.get("/", (req, res) => {
    res.send("Route is working");
});
//--------------------------- EOF Route for root path ---------------------------

app.listen(port, () => {
    console.log(`Server is listening on port ${port}`);
});
