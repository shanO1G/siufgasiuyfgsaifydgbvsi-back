const mongoose = require('mongoose');
const assert = require('assert');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const modelsDir = path.join(__dirname, '../api/models');

async function testSchemas() {
  console.log('--- Starting Schema Compilation & Validation Check ---');

  // 1. Read all model files in the shared/models directory
  const files = fs.readdirSync(modelsDir);
  console.log(`Found ${files.length} model files in ${modelsDir}`);

  // 2. Import each file and verify it registers as a model
  for (const file of files) {
    if (file.endsWith('.js')) {
      const modelName = path.basename(file, '.js');
      console.log(`Importing ${modelName} model...`);
      const model = require(path.join(modelsDir, file));
      assert.ok(model, `Failed to load model from ${file}`);
      assert.ok(mongoose.models[modelName] || mongoose.models[model.modelName], `Model ${modelName} was not registered under Mongoose`);
    }
  }

  console.log('✓ All model schemas compiled and registered with Mongoose successfully!');

  // 3. Connect to MongoDB if MONGODB_URI is provided
  const mongoUri = process.env.MONGODB_URI;
  if (mongoUri) {
    console.log(`Connecting to database to verify indexes...`);
    const connectDB = require('../api/utils/db');
    await connectDB(mongoUri);
    
    // Check if models can sync indexes successfully
    for (const name of mongoose.modelNames()) {
      console.log(`Syncing indexes for ${name}...`);
      await mongoose.model(name).syncIndexes();
    }
    console.log('✓ All model indexes synced successfully with the database!');
    await mongoose.connection.close();
  } else {
    console.log('Skipping database index synchronization check (no MONGODB_URI found).');
  }

  console.log('--- Validation Finished Successfully! ---');
}

testSchemas().catch(err => {
  console.error('Schema Validation Failed:', err);
  process.exit(1);
});
