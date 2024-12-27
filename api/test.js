module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    
    return res.json({
      message: 'API is working!',
      time: new Date().toISOString()
    });
  };