import React from 'react';
import { HashRouter as Router, Routes, Route } from 'react-router-dom';
import HomeScreen from './screens/HomeScreen';
import CaptureScreen from './screens/CaptureScreen';
import OrganizerScreen from './screens/OrganizerScreen';

const App: React.FC = () => {
    return (
        <Router>
            <Routes>
                <Route path="/" element={<HomeScreen />} />
                <Route path="/capture" element={<CaptureScreen />} />
                <Route path="/organizer" element={<OrganizerScreen />} />
            </Routes>
        </Router>
    );
};

export default App;
