const express = require("express");
const fetch = require("node-fetch");
const xml2js = require("xml2js");
const cors = require("cors"); // Add CORS support

const app = express();

// Global error handlers
process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error);
  console.error('Stack:', error.stack);
  // Gracefully close server
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise);
  console.error('Reason:', reason);
  // Log but don't exit - let the app continue
});

// Handle SIGTERM and SIGINT gracefully
process.on('SIGTERM', () => {
  console.log('📡 SIGTERM received, shutting down gracefully');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('📡 SIGINT received, shutting down gracefully');
  process.exit(0);
});

// Middleware
app.use(cors()); // Enable CORS for React frontend
app.use(express.json());

// Your SOAP service details (replace with real values)
const SOAP_URL = "https://www.assuresign.net/Services/DocumentNOW/v2/DocumentNOW.svc/Envelopes/text";
const SOAP_ACTION = "https://www.assuresign.net/Services/DocumentNOW/Envelopes/IEnvelopeService/DeleteEnvelope";

// Helper: build a SOAP XML envelope for a chunk of rows
function buildSoapEnvelope(data, contextId) {
  return `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
  <s:Body xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">
    <DeleteEnvelope xmlns="https://www.assuresign.net/Services/DocumentNOW/Envelopes">
      <Requests>
        ${data
          .map(
            (row, i) => 
          `<DeleteEnvelopeRequest ContextIdentifier="${contextId}" EnvelopeId="${row["EnvelopeId"].trim()}" EnvelopeAuthToken="${row["AuthToken"].trim()}" />`
          ).join("")}
      </Requests>
    </DeleteEnvelope>
  </s:Body>
</s:Envelope>`;
}

// Helper: split array into chunks of 50
function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

// POST endpoint React calls
app.post("/api/send-soap", async (req, res) => {
  const { data, contextId } = req.body;
  
  // Validate input
  if (!data || !Array.isArray(data)) {
    return res.status(400).json({ error: "No valid data provided" });
  }
  
  if (!contextId) {
    return res.status(400).json({ error: "ContextId is required" });
  }

  try {
    const chunks = chunkArray(data, 50);
    const responses = [];

    for (let i = 0; i < chunks.length; i++) {
      try {
        const xmlBody = buildSoapEnvelope(chunks[i], contextId);
        
        console.log(`\n--- Batch ${i + 1}/${chunks.length} ---`);
        console.log(`Sending ${chunks[i].length} envelope deletion requests`);

        // Set a timeout for the fetch request
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 second timeout

        const response = await fetch(SOAP_URL, {
          method: "POST",
          headers: {
            "Content-Type": "text/xml; charset=utf-8",
            "SOAPAction": SOAP_ACTION,
            "Accept": "text/xml, application/soap+xml, application/xml",
            "User-Agent": "Node.js SOAP Client", // Add User-Agent
          },
          body: xmlBody,
          signal: controller.signal, // Add abort signal
        }).finally(() => {
          clearTimeout(timeoutId); // Clear timeout
        });

        // Check if the response is ok
        if (!response.ok) {
          console.error(`HTTP Error: ${response.status} ${response.statusText}`);
          let errorText;
          try {
            errorText = await response.text();
          } catch (textError) {
            errorText = `Could not read error response: ${textError.message}`;
          }
          console.error("Error response body:", errorText);
          
          return res.status(response.status).json({ 
            error: `SOAP service returned ${response.status}: ${response.statusText}`,
            details: errorText,
            batch: i + 1
          });
        }

        // Fixed: Use response.text() instead of response.data with error handling
        let responseText;
        try {
          responseText = await response.text();
        } catch (textError) {
          console.error(`Error reading response text for batch ${i + 1}:`, textError);
          return res.status(500).json({
            error: "Failed to read SOAP response",
            details: textError.message,
            batch: i + 1
          });
        }

        console.log(`✅ Batch ${i + 1} Status: ${response.status}`);
        console.log("Response preview:", responseText.substring(0, 200) + "...");

        // Optional: Parse XML response to JSON with error handling
        let parsedResponse = null;
        try {
          const parser = new xml2js.Parser({ 
            explicitArray: false,
            ignoreAttrs: false,
            trim: true,
            normalize: true,
            normalizeTags: true,
            explicitRoot: false
          });
          parsedResponse = await parser.parseStringPromise(responseText);
        } catch (parseError) {
          console.warn(`Could not parse XML response for batch ${i + 1}:`, parseError.message);
          // Continue with null parsedResponse - this is not a critical error
        }

        responses.push({ 
          batch: i + 1, 
          status: response.status,
          rawResponse: responseText,
          parsedResponse: parsedResponse,
          itemCount: chunks[i].length,
          success: true
        });

        // Optional: Add delay between batches to avoid rate limiting
        if (i < chunks.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 10000)); // 100ms delay
        }

      } catch (batchError) {
        console.error(`❌ Error processing batch ${i + 1}:`, batchError);
        
        // Handle specific error types
        if (batchError.name === 'AbortError') {
          return res.status(408).json({
            error: "Request timeout",
            details: `Batch ${i + 1} timed out after 30 seconds`,
            batch: i + 1
          });
        }

        if (batchError.code === 'ENOTFOUND' || batchError.code === 'ECONNREFUSED') {
          return res.status(503).json({
            error: "Service unavailable",
            details: `Cannot connect to SOAP service: ${batchError.message}`,
            batch: i + 1
          });
        }

        // Add failed batch to responses but continue with next batch
        responses.push({
          batch: i + 1,
          status: 'error',
          error: batchError.message,
          itemCount: chunks[i].length,
          success: false
        });

        // Decide whether to continue or stop
        // For now, let's continue with other batches
        console.log(`⚠️ Continuing with remaining batches...`);
      }
    }

    console.log(`\n🎉 Processing completed. ${responses.filter(r => r.success).length}/${chunks.length} batches successful`);
    
    // Return all responses back to React
    res.json({ 
      success: responses.some(r => r.success), // True if any batch succeeded
      totalBatches: chunks.length,
      totalItems: data.length,
      successfulBatches: responses.filter(r => r.success).length,
      results: responses 
    });

  } catch (error) {
    console.error("❌ SOAP Error:", error);
    console.error("Stack trace:", error.stack);
    
    // More detailed error response
    res.status(500).json({ 
      success: false,
      error: "SOAP call failed",
      details: error.message,
      type: error.name,
      code: error.code,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// Health check endpoint
app.get("/api/health", (req, res) => {
  res.json({ status: "OK", message: "SOAP server is running" });
});

// Start HTTP server
const PORT = process.env.PORT || 3001;
const server = app.listen(PORT, () => {
  console.log(`🚀 Express server running at http://localhost:${PORT}`);
  console.log(`🔍 Health check: http://localhost:${PORT}/api/health`);
});

// Handle server errors
server.on('error', (error) => {
  console.error('❌ Server error:', error);
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Try a different port.`);
    process.exit(1);
  }
});

// Graceful shutdown
const gracefulShutdown = () => {
  console.log('📡 Received shutdown signal, closing server gracefully...');
  server.close((err) => {
    if (err) {
      console.error('❌ Error during server close:', err);
      process.exit(1);
    }
    console.log('✅ Server closed successfully');
    process.exit(0);
  });
};

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);